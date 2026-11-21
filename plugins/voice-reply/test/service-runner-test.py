"""CPU-only adapter tests; run with the GPT distribution's runtime/python.exe."""
import asyncio
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

SPEC = importlib.util.spec_from_file_location("voice_service_runner", Path(__file__).resolve().parents[1] / "service-runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class FakeTensor:
    """Small duck-typed tensor to exercise detach/CPU/clone/device restoration."""
    def __init__(self, data, device="cuda:0"):
        self.data = np.array(data, dtype=np.int64)
        self.device = device

    def detach(self):
        return self

    def cpu(self):
        return FakeTensor(self.data, "cpu")

    def clone(self):
        return FakeTensor(self.data.copy(), self.device)

    def to(self, device):
        return FakeTensor(self.data, device)

    def tolist(self):
        return self.data.tolist()

    def numel(self):
        return self.data.size

    def element_size(self):
        return self.data.itemsize

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        value = self.data[index]
        return FakeTensor(value, self.device) if isinstance(value, np.ndarray) else value


class FakeModel:
    def __init__(self, pipeline):
        self.pipeline = pipeline
        self.infer_panel = self.infer_panel_batch_infer

    def infer_panel_batch_infer(self, phones, lengths, prompts, bert, **kwargs):
        self.pipeline.calls += 1
        result = []
        for _ in phones:
            data = [999, self.pipeline.calls, self.pipeline.calls + 10]
            if self.pipeline.output_type == "tensor":
                value = FakeTensor(data)
            elif self.pipeline.output_type == "list":
                value = data
            else:
                value = np.array(data, dtype=np.int64)
            result.append(value)
        return result, [np.int64(2) for _ in phones]

    def infer_panel_naive_batched(self, *args, **kwargs):
        return self.infer_panel_naive(*args, **kwargs)

    def infer_panel_naive(self, *args, **kwargs):
        # Use the class function to avoid accidentally exercising batch wrapper
        # recursion; real naive_batched calls the unwrapped naive generator.
        return FakeModel.infer_panel_batch_infer(self, *args, **kwargs)


class FakeTTS:
    def __init__(self, output_type="numpy"):
        self.configs = SimpleNamespace(t2s_weights_path="voice-A.ckpt", device="cuda:1", hz=50, max_sec=30)
        self.prompt_cache = {"phones": [9]}
        self.t2s_model = SimpleNamespace(model=FakeModel(self))
        self.calls = 0
        self.output_type = output_type
        self.observed = []
        self.stop_flag = False

    def reload(self):
        self.t2s_model = SimpleNamespace(model=FakeModel(self))

    def run(self, req):
        self.stop_flag = False
        model = self.t2s_model.model
        # Same late assignment as the real TTS.run implementation.
        model.infer_panel = model.infer_panel_batch_infer if req.get("parallel_infer", True) else model.infer_panel_naive_batched
        self.prompt_cache["phones"] = list(req.get("reference_phones", [9]))
        values = []
        for index, chunk in enumerate(req.get("text", "hello").split("|")):
            target = [ord(c) for c in chunk]
            if req.get("changed_phones"):
                target.append(1234)
            phones = [np.array(self.prompt_cache["phones"] + target)]
            pred, idx = model.infer_panel(phones, np.array([len(phones[0])]), np.array([[1]]), [np.zeros((2, len(phones[0])))])
            self.observed.append((pred, idx))
            tokens = runner._tolist(pred[0])[-int(idx[0]):]
            values.extend(tokens)
            if req.get("fail_batch") == index:
                raise RuntimeError("inference failed")
        if req.get("stop"):
            self.stop_flag = True
        audio = np.array(values, dtype=np.int16)
        if req.get("silent") or req.get("stop"):
            audio = np.zeros(3, dtype=np.int16)
        # Fake decoder reflects speed/tone changes while semantic tokens stay.
        yield 32000, audio + (0 if req.get("silent") or req.get("stop") else int(req.get("speed_factor", 1) * 10))
        if req.get("fail_after_yield"):
            raise RuntimeError("late inference cleanup failed")


class SemanticTests(unittest.TestCase):
    def make(self, **kwargs):
        pipeline = FakeTTS(kwargs.pop("output_type", "numpy"))
        return pipeline, runner.SemanticCache(pipeline, **kwargs).install()

    def request(self, pipeline, **kwargs):
        return list(pipeline.run({"text": "first|second", "text_lang": "en", **kwargs}))[0][1]

    def test_normal_caches_and_freeze_reuses_all_batches_across_reload_and_voice_speed(self):
        pipeline, cache = self.make()
        self.request(pipeline)
        self.assertEqual(pipeline.calls, 2)
        self.assertEqual(cache.last_result, "miss")
        saved = [[v.copy() for v in batch[1][0]] for batch in cache.latest[1]]
        old = pipeline.t2s_model.model
        self.assertNotIn("infer_panel_batch_infer", vars(old))
        pipeline.reload()
        pipeline.configs.vits_weights_path = "another-tone.pth"
        self.request(pipeline, if_freeze=True, speed_factor=1.6, reference_phones=[8, 7, 6], ref_audio_path="different.wav", prompt_text="new reference", top_k=2, temperature=0.5)
        self.assertEqual(pipeline.calls, 2)
        self.assertEqual(cache.last_result, "hit")
        for old_batch, new_batch in zip(saved, cache.latest[1]):
            np.testing.assert_array_equal(old_batch[0], new_batch[1][0][0])
        self.assertNotIn("infer_panel_batch_infer", vars(pipeline.t2s_model.model))
        self.assertNotIn("infer_panel_naive_batched", vars(pipeline.t2s_model.model))
        self.assertNotEqual(pipeline.observed[-1][0][0][0], 999)  # cached reference prefix removed

    def test_naive_mode_wraps_outer_batch_once(self):
        pipeline, cache = self.make()
        self.request(pipeline, parallel_infer=False)
        self.request(pipeline, parallel_infer=False, if_freeze=True)
        self.assertEqual(pipeline.calls, 2)
        self.assertEqual(len(cache.latest[1]), 2)
        self.assertEqual(cache.last_result, "hit")

    def test_prompt_free_batch_fallback_records_outer_call_only(self):
        pipeline, cache = self.make()
        model = pipeline.t2s_model.model
        def batch_fallback(*args, **kwargs):
            return model.infer_panel_naive_batched(*args, **kwargs)
        model.infer_panel_batch_infer = batch_fallback
        self.request(pipeline)
        self.assertEqual(len(cache.latest[1]), 2)
        self.request(pipeline, if_freeze=True)
        self.assertEqual(pipeline.calls, 2)
        self.assertEqual(cache.last_result, "hit")

    def test_freeze_without_matching_result_samples_and_saves(self):
        pipeline, cache = self.make()
        self.request(pipeline, if_freeze=True)
        self.assertEqual(pipeline.calls, 2)
        self.assertEqual(cache.last_result, "miss")
        self.request(pipeline, if_freeze=True)
        self.assertEqual(cache.last_result, "hit")

    def test_text_language_cut_gpt_and_batch_changes_miss(self):
        changes = [{"text": "different|second"}, {"text_lang": "ja"}, {"text_split_method": "cut2"}, {"batch_size": 2}, {"changed_phones": True}]
        for change in changes:
            pipeline, cache = self.make()
            self.request(pipeline)
            self.request(pipeline, if_freeze=True, **change)
            self.assertEqual(pipeline.calls, 4, change)
            self.assertEqual(cache.last_result, "miss")
        pipeline, cache = self.make()
        self.request(pipeline)
        pipeline.configs.t2s_weights_path = "voice-B.ckpt"
        self.request(pipeline, if_freeze=True)
        self.assertEqual(pipeline.calls, 4)

    def test_gpt_file_replacement_at_same_path_misses(self):
        pipeline, cache = self.make()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.ckpt"
            path.write_bytes(b"first")
            pipeline.configs.t2s_weights_path = str(path)
            self.request(pipeline)
            path.write_bytes(b"replacement with different size")
            self.request(pipeline, if_freeze=True)
        self.assertEqual(pipeline.calls, 4)
        self.assertEqual(cache.last_result, "miss")

    def test_failure_after_batch_or_after_yield_keeps_previous_complete_result(self):
        for failure in [{"fail_batch": 0}, {"fail_after_yield": True}]:
            pipeline, cache = self.make()
            self.request(pipeline)
            previous = cache.latest
            with self.assertRaises(RuntimeError):
                self.request(pipeline, text="other|target", **failure)
            self.assertIs(cache.latest, previous)
            self.assertFalse(cache._guard.locked())
            self.assertNotIn("infer_panel_batch_infer", vars(pipeline.t2s_model.model))
            self.request(pipeline, if_freeze=True)
            self.assertEqual(cache.last_result, "hit")

    def test_closed_generator_silent_and_stopped_results_do_not_commit(self):
        pipeline, cache = self.make()
        self.request(pipeline)
        previous = cache.latest
        generator = pipeline.run({"text": "different"})
        next(generator)
        generator.close()
        self.assertIs(cache.latest, previous)
        for change in [{"silent": True}, {"stop": True}]:
            self.request(pipeline, text="other", **change)
            self.assertIs(cache.latest, previous)
        self.assertFalse(cache._guard.locked())

    def test_only_latest_complete_result_survives(self):
        pipeline, cache = self.make()
        self.request(pipeline)
        self.request(pipeline, text="replacement")
        self.assertEqual(len(cache.latest[1]), 1)
        self.request(pipeline, if_freeze=True)
        self.assertEqual(pipeline.calls, 5)
        self.assertEqual(cache.last_result, "miss")

    def test_bounds_drop_oversized_success_and_reject_incomplete_semantics(self):
        for options in [{"max_bytes": 20}, {"max_batches": 1}]:
            pipeline, cache = self.make(**options)
            self.request(pipeline)
            self.assertIsNone(cache.latest)
        pipeline, cache = self.make()
        model = pipeline.t2s_model.model
        model.infer_panel_batch_infer = lambda *args, **kwargs: ([np.array([1, 2])], [])
        with self.assertRaises(IndexError):
            self.request(pipeline)
        self.assertIsNone(cache.latest)

    def test_numpy_list_and_tensor_outputs_are_cloned_and_tensor_restored_on_live_device(self):
        for output_type in ["numpy", "list", "tensor"]:
            pipeline, cache = self.make(output_type=output_type)
            self.request(pipeline)
            retained = cache.latest[1][0][1][0][0]
            if output_type == "tensor":
                self.assertEqual(retained.device, "cpu")
                pipeline.observed[0][0][0].data[-1] = -777
            else:
                pipeline.observed[0][0][0][-1] = -777
            self.request(pipeline, if_freeze=True)
            output = pipeline.observed[-2][0][0]
            self.assertNotIn(-777, runner._tolist(output))
            if output_type == "tensor":
                self.assertEqual(output.device, "cuda:1")
                output.data[-1] = -888
                self.assertNotIn(-888, runner._tolist(cache.latest[1][0][1][0][0]))

    def test_direct_concurrent_generator_fails_immediately_without_corrupting_active_cache(self):
        pipeline, cache = self.make()
        first = pipeline.run({"text": "first"})
        next(first)
        with self.assertRaisesRegex(RuntimeError, "busy"):
            next(pipeline.run({"text": "second"}))
        with self.assertRaises(StopIteration):
            next(first)
        self.assertEqual(cache.latest[0][0], "first")
        self.assertFalse(cache._guard.locked())


class MiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_routes_serialized_through_response_but_status_bypasses(self):
        entered = []
        release = asyncio.Event()
        async def app(scope, receive, send):
            entered.append(scope["path"])
            if scope["path"] == "/tts":
                await release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"done"})
        middleware = runner.ModelRequestLock(app, SimpleNamespace(last_result="hit"))
        sent = []
        async def send(message):
            sent.append(message)
        async def receive():
            return {"type": "http.request", "body": b""}
        def call(path):
            return middleware({"type": "http", "path": path}, receive, send)
        first = asyncio.create_task(call("/tts"))
        await asyncio.sleep(0)
        second = asyncio.create_task(call("/set_gpt_weights"))
        await asyncio.sleep(0)
        await asyncio.wait_for(call("/voice-reply/status"), 1)
        await asyncio.wait_for(call("/openapi.json"), 1)
        self.assertEqual(entered, ["/tts", "/voice-reply/status", "/openapi.json"])
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(entered[-1], "/set_gpt_weights")
        self.assertTrue(any((b"x-voice-semantic-cache", b"miss") in msg.get("headers", []) for msg in sent))

    async def test_actual_fastapi_routes_metadata_json_and_original_get_share_cache(self):
        try:
            from fastapi import FastAPI
            from fastapi.responses import Response
            import httpx
        except ImportError as error:
            self.skipTest(f"GPT-SoVITS runtime provides fastapi/httpx; not installed here: {error}")
        pipeline = FakeTTS()
        app = FastAPI()
        async def handle(req):
            result = list(pipeline.run(req))
            return Response(result[-1][1].tobytes(), media_type="audio/wav")
        @app.get("/tts")
        async def original(text: str = "first|second"):
            return await handle({"text": text, "text_lang": "en"})
        runner.attach_adapter({"APP": app, "tts_pipeline": pipeline, "tts_handle": handle})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            status = (await client.get("/voice-reply/status")).json()
            self.assertEqual(status["adapter"], "roost-voice-reply")
            self.assertEqual(status["features"], {"semanticFreeze": True})
            self.assertFalse(status["cacheReady"])
            schema = (await client.get("/openapi.json")).json()
            self.assertIn("post", schema["paths"]["/voice-reply/tts"])
            first = await client.get("/tts")
            self.assertEqual(first.headers["x-voice-semantic-cache"], "miss")
            second = await client.post("/voice-reply/tts", json={"text": "first|second", "text_lang": "en", "if_freeze": True, "speed_factor": 1.5})
            self.assertEqual(second.status_code, 200)
            self.assertEqual(second.headers["x-voice-semantic-cache"], "hit")
            self.assertEqual(pipeline.calls, 2)
            self.assertNotEqual(first.content, second.content)
            for invalid in [[], {"if_freeze": "true"}, {"streaming_mode": True}]:
                self.assertEqual((await client.post("/voice-reply/tts", json=invalid)).status_code, 400)
            self.assertEqual((await client.post("/voice-reply/tts", content="{" )).status_code, 400)
            self.assertNotIn("first", json_text := (await client.get("/voice-reply/status")).text)
            self.assertNotIn("voice-A", json_text)


class BootstrapTests(unittest.TestCase):
    def test_runpy_nonmain_argv_cwd_sys_path_then_restore_argv(self):
        import os
        import sys
        old_cwd, old_path, old_argv = os.getcwd(), list(sys.path), sys.argv
        try:
            with tempfile.TemporaryDirectory() as directory:
                api = Path(directory) / "api_v2.py"
                api.write_text("# bootstrap fixture", encoding="utf-8")
                captured = {}
                def fake_run(path, run_name):
                    captured.update(path=path, run_name=run_name, cwd=os.getcwd(), argv=list(sys.argv), paths=list(sys.path))
                    return {"fixture": True}
                with patch.object(runner.runpy, "run_path", side_effect=fake_run), patch.object(runner, "attach_adapter", return_value="APP"):
                    self.assertEqual(runner.load_app(directory, "127.0.0.1", 9988, "GPT_SoVITS/configs/custom.yaml"), "APP")
                self.assertNotEqual(captured["run_name"], "__main__")
                self.assertEqual(captured["cwd"], str(Path(directory).resolve()))
                self.assertEqual(captured["argv"][-2:], ["-c", "GPT_SoVITS/configs/custom.yaml"])
                self.assertIn(str(Path(directory).resolve() / "GPT_SoVITS"), captured["paths"])
                self.assertIs(sys.argv, old_argv)
                os.chdir(old_cwd)
        finally:
            os.chdir(old_cwd)
            sys.path[:] = old_path
            sys.argv = old_argv


if __name__ == "__main__":
    unittest.main(verbosity=2)

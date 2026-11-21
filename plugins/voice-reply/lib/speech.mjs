export const BUILTIN_LINES = [
  'はいはい、聞こえてるよ。何の用？', '呼んだ？別に暇じゃないんだけど。',
  'うん、ちゃんと聞いてる。続けて。', 'なに？そんなにじっと見ないでよ。',
  'はい、いますよ。ご用件は？', 'ちょっと、そんなこと言われたら照れるじゃない。',
  'べ、別に嬉しくなんかないんだからね。', 'もう……しょうがないなあ、君は。',
  '少しだけなら、付き合ってあげてもいいよ。', 'ふふっ、今日は機嫌がいいみたいだね。',
  'またそんなこと言って。学習しないねえ。', 'その言い方、ちょっと失礼じゃない？',
  'はいはい、どうせ私は電池切れですよ。', 'そういうのは、まず自分でやってみなよ。',
  'んー、それはちょっと無理かも。ごめんね。', '今日はいい天気だね。どこか行きたい気分。',
  'ちょっと疲れた……少し休ませて。', 'お腹すいた。なにか食べるものない？',
  '静かなのも、たまには悪くないね。', '夜更かしはほどほどにね。',
  'それじゃ、またあとで。', '気をつけて帰ってね。', 'おやすみ。いい夢見てね。', 'ちゃんと寝なさいよ。じゃあね。',
];
const JA = /[\u3040-\u30ff]/;
export function langOf(text, fallback = 'auto') {
  if (fallback !== 'auto') return fallback;
  if (JA.test(text)) return 'ja';
  if (/[\u3400-\u9fff]/.test(text)) return 'zh';
  if (/[a-z]/i.test(text)) return 'en';
  return 'auto';
}
export function cleanText(raw, max = 300) {
  return Array.from(String(raw).replace(/<<[\s\S]*?>>/g, '').replace(/<[^>]*>/g, '').replace(/```[\s\S]*?```/g, '').replace(/[*_`#]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}
export function parseAsk(message, keywords) {
  const raw = String(message).replace(/<@!?[^>]+>/g, '').replace(/^\s*[@＠][^\s,，]+\s+/, '').trim();
  const words = String(keywords).split(/[,，\n]/).map(x => x.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const kw of words) {
    const i = raw.toLowerCase().indexOf(kw.toLowerCase());
    if (i < 0) continue;
    let rest = raw.slice(i + kw.length).replace(/^[\s，,。.!！?？、:：;；~～]+/, '').trim();
    const bare = rest.replace(/[\s，,。.!！?？、:：;；~～]/g, '');
    if (bare.length < 2 || /^(吗|呢|吧|啊|嘛|呀|试试|试一下)+$/.test(bare)) rest = '';
    return { asked: true, rest };
  }
  return { asked: false, rest: '' };
}
export function pickLine(custom = [], recent = [], random = Math.random) {
  const own = custom.map(x => cleanText(x)).filter(Boolean);
  const pool = own.length ? own : BUILTIN_LINES;
  const fresh = pool.filter(x => !recent.includes(x));
  const use = fresh.length ? fresh : pool;
  return use[Math.min(use.length - 1, Math.floor(random() * use.length))];
}
/** 翻译失败保留原文；正文不会被无关台词替换。 */
export async function composeSpeech({ text = '', message = '', c, recent = [], translate, random }) {
  let said = text;
  if (!said.trim() && message) {
    const ask = parseAsk(message, c.keywords);
    if (!ask.asked) return { mode: 'text', reason: '这句未匹配语音请求；需要朗读时请传 text' };
    said = ask.rest;
  }
  const clean = cleanText(said, c.maxChars);
  if (said.trim() && !clean) throw new Error('正文清理后为空，请提供可朗读的文字');
  if (!clean) {
    const line = cleanText(pickLine(c.lines, recent, random), c.maxChars);
    return { text: line, lang: langOf(line, c.textLang), source: 'library' };
  }
  let warning;
  if (c.translateApi && !JA.test(clean)) {
    try {
      const ja = cleanText(await translate(clean), c.maxChars);
      if (!JA.test(ja)) throw new Error('翻译返回非日语内容');
      return { text: ja, lang: 'ja', source: 'translated' };
    } catch { warning = '翻译未成功，已按原文合成'; }
  }
  return { text: clean, lang: langOf(clean, c.textLang), source: 'echo', ...(warning ? { warning } : {}) };
}

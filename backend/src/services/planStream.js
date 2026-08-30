/**
 * 把「写到一半的 JSON」变成老师看得懂的一段话。
 *
 * 为什么需要它：生成教案那次调用要模型返回**一整个 JSON**
 * （title / intent / objectives / flow…，见 lessonGenerator 的 jsonShape）。
 * 流式吐出来的原样是这个样子：
 *   {"title": "沉浮小侦探", "intent": "设计这个活动是因为孩子们在洗手时经常玩水
 * 直接摊给老师看，她看到的是一堆花括号和引号 —— 那不叫「它在替我写」，
 * 那叫「它坏了」。
 *
 * 🔴 **输出必须是只增不减的**（`readablePrefix(raw + more)` 一定以
 * `readablePrefix(raw)` 开头）。整套增量协议（epoch + from 游标）建立在这一条上：
 * 后端只回「上次之后新长出来的那一段」，前端往后拼。做法上有两条纪律：
 *   1. **键名没收完整（结尾还差半个字）就一个字都不发** —— 发了之后
 *      认出它是 flow 还是 focus，已经来不及改口
 *   2. **结尾绝不 trim** —— 掐掉尾巴的空白，下一次它又长回来，
 *      拼出来就会多一截。开头的空白可以掐（那一截定下来就不再变）
 * 真出了我没想到的边界，taskQueue 那边有一道兜底：新文本不以旧文本开头就
 * 换一个 epoch 重发全量，前端跟着重画。**慢一拍，但不会花屏。**
 */

/**
 * 顶层字段 → 小标题。**只认顶层**：嵌套里的 `stage` / `detail` / `focus`
 * 是给程序读的字段名，印在屏幕上只是噪音。
 *
 * 认不出来的键一个字都不写（不写「flow：」这种），
 * 因为这一屏的用处是让她看见**教案正文**在长出来，不是看见数据结构。
 */
const SECTIONS = {
  title: '',                 // 标题就是抬头，不另加小标题
  intent: '设计意图',
  objectives: '活动目标',
  key_points: '活动重点难点',
  preparation: '活动准备',
  flow: '活动过程',
  extension: '活动延伸',
  safety: '安全提示',
  steam: 'STEAM 五域',
  indicators: '《指南》指标',
  dialogue: '教学实例',
};

/**
 * 这些键的**值**不显示。
 *
 * `speaker` 的值是 'T' / 'C' —— 那是存进库里给程序分辨说话人用的代号。
 * 它单独占一行就是一个孤零零的大写字母，看起来像乱码。
 * 想把它译成「老师：」是做不到的：译要等值收完，而收完时那个字母已经发出去了
 * （只增不减，改不了口）。少一个称呼，比屏幕上蹦出一个 T 好。
 */
const SKIP_VALUES = new Set(['speaker']);

const ESCAPES = { n: '\n', t: ' ', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };

/**
 * @param {string} raw 模型到目前为止吐出来的原始文本（可能是半截 JSON）
 * @returns {string} 能直接摆给老师看的一段话
 */
export function readablePrefix(raw) {
  const s = String(raw || '');
  let out = '';

  const stack = [];          // '{' / '[' —— 用来判断下一个字符串是键还是值
  let expectKey = false;
  let inStr = false;
  let isKey = false;
  let esc = false;
  let uni = null;            // \uXXXX 收到一半时攒在这里
  let keyBuf = '';           // 键名要收完整才算数，见文件头第 1 条纪律
  let curKey = '';           // 当前这个值属于哪个键（用来查 SKIP_VALUES）
  let mute = false;          // 这个值不显示

  const emit = (ch) => { if (!mute) out += ch; };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];

    if (inStr) {
      if (uni !== null) {
        uni += ch;
        if (uni.length === 4) {
          const code = parseInt(uni, 16);
          // 认不出来就当没有这个字符 —— 半个转义序列不该变成一个问号
          if (Number.isFinite(code)) {
            if (isKey) keyBuf += String.fromCharCode(code);
            else emit(String.fromCharCode(code));
          }
          uni = null;
        }
        continue;
      }
      if (esc) {
        esc = false;
        if (ch === 'u') { uni = ''; continue; }
        const d = ESCAPES[ch] ?? '';
        if (isKey) keyBuf += d;
        else emit(d);
        continue;
      }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') {
        inStr = false;
        if (isKey) {
          curKey = keyBuf;
          // 只有顶层认得出来的键才写小标题。stack.length === 1 = 就在最外层那个 {} 里
          const label = stack.length === 1 ? SECTIONS[curKey] : undefined;
          if (label) out += `\n${label}\n`;
        } else {
          // 每个值单独一行。不这么分行的话「导入」和后面那段做法会连成一句
          emit('\n');
          mute = false;
        }
        continue;
      }
      if (isKey) keyBuf += ch;
      else emit(ch);
      continue;
    }

    if (ch === '"') {
      inStr = true;
      isKey = expectKey;
      if (isKey) keyBuf = '';
      else mute = SKIP_VALUES.has(curKey);
      continue;
    }
    if (ch === '{') { stack.push('{'); expectKey = true; continue; }
    if (ch === '[') { stack.push('['); expectKey = false; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; continue; }
    if (ch === ',') { expectKey = stack[stack.length - 1] === '{'; continue; }
    if (ch === ':') { expectKey = false; continue; }
    // 数字、true/false/null、空白：不显示。少一样噪音，而且 minutes 那种数字
    // 单独占一行会读成「5」
  }

  /* 空行收成最多一个。**只收中间，不动结尾** —— 结尾 trim 掉之后
     下一段字一来它又长回来，拼接就会多一截空行（见文件头第 2 条纪律）。
     开头那几个换行掐得掉：一旦有正文，开头就再也不变了。 */
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

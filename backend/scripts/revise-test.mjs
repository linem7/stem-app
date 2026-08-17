/** 改稿链路验证：提意见 → 拿 3 题 → 答完 → 重新生成 → 看意见有没有落实 */
const BASE='http://localhost:3000';
let token=null;
async function call(m,p,b){
  const r=await fetch(`${BASE}/v1${p}`,{method:m,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
  const j=await r.json().catch(()=>({ok:false,error:{message:'非JSON'}}));
  if(!r.ok||j.ok===false) throw new Error(`${m} ${p} → ${r.status} ${JSON.stringify(j.error)}`);
  return j.data;
}
const L=console.log;

token=(await call('POST','/auth/login',{code:'dev:test001'})).data?.token
   || (await call('POST','/auth/login',{code:'dev:test001'})).token;

const before=await call('GET','/lesson-plans/1');
L(`改前：《${before.title}》v${before.version} · ${before.duration_min}分钟 · ${before.content_json.flow.length}环节`);
L(`      材料 ${before.content_json.materials.length} 样：${before.content_json.materials.slice(0,4).join('、')}`);

const FEEDBACK='我们班只有12个孩子，而且只有一个水盆，分组轮流会等太久';
L(`\n老师说：${FEEDBACK}`);

const r1=await call('POST','/lesson-plans/1/revise',{feedback:FEEDBACK});
L(`\nAI：${r1.ack}`);
L(`第 ${r1.revise_round} 轮追问，共 ${r1.questions.length} 题：`);
r1.questions.forEach((q,i)=>{
  L(`  ${i+1}. ${q.title}${q.hint?`（${q.hint}）`:''}`);
  q.options.forEach(o=>L(`     ${o.key}. ${o.label}${o.sub?` — ${o.sub}`:''}`));
});

// 关键校验：这三题不能是引导阶段问过的
const GUIDE=['这次活动是给哪个年龄班的？','你希望孩子在这次活动里主要收获什么？','有什么现实条件要考虑吗？','活动大概安排多长时间？','还有什么想让我注意的？'];
const dup=r1.questions.filter(q=>GUIDE.includes(q.title));
L(`\n${dup.length?'✗ 有 '+dup.length+' 题跟引导阶段重复：'+dup.map(q=>q.title).join(' / '):'✓ 三题都是新的，没有重复问'}`);

// 答题：每题选第一个
const answers=r1.questions.map(q=>({question_id:q.id,selected:[q.options[0].key],custom_text:null}));
L(`\n答：${r1.questions.map((q,i)=>q.options[0].label).join(' / ')}`);

const t=await call('POST','/lesson-plans/1/revise/answer',{revise_round:r1.revise_round,answers});
L(`\n已提交重新生成 · ${t.task_id}`);

const convId=before.conversation_id;
let st, s0=Date.now();
for(let i=0;i<60;i++){
  await new Promise(r=>setTimeout(r,2000));
  st=await call('GET',`/conversations/${convId}/generate/status`);
  if(st.status!=='generating') break;
}
L(`轮询结束：${st.status}，耗时 ${Math.round((Date.now()-s0)/1000)} 秒`);
if(st.status!=='completed'){ L('✗ 重新生成失败'); process.exit(1); }

const after=await call('GET','/lesson-plans/1');
L(`\n改后：《${after.title}》v${after.version} · ${after.duration_min}分钟 · ${after.content_json.flow.length}环节`);
L(`      材料 ${after.content_json.materials.length} 样：${after.content_json.materials.slice(0,4).join('、')}`);
L(`\nversion ${before.version} → ${after.version} ${after.version>before.version?'✓ 已 +1':'✗ 没变'}`);

const txt=JSON.stringify(after.content_json);
L(`意见落实自检：`);
L(`  提到 12 个孩子 / 人数调整：${/12|十二/.test(txt)?'✓':'? 没直接出现数字，看下面正文'}`);
L(`  水盆数量相关：${/一个水盆|1个水盆|单个水盆|轮流|依次/.test(txt)?'✓ 有相应安排':'?'}`);
L(`\n改后流程：`);
after.content_json.flow.forEach(f=>L(`  ${f.stage}（${f.minutes}分）${f.detail.slice(0,60)}…`));

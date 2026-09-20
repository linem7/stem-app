/** 运营链路验证：兑换码激活 → 协议闸门 → 开会话 → 额度台账 */
import { activateAccount } from './_test-account.mjs';
const BASE=process.env.API_BASE||'http://localhost:3000'; let token=null;
async function call(m,p,b){
  const r=await fetch(`${BASE}/v1${p}`,{method:m,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
  const j=await r.json().catch(()=>({ok:false,error:{message:'非JSON'}}));
  return {status:r.status, ok:j.ok, data:j.data, error:j.error};
}
const L=console.log; let fail=0;
const chk=(cond,msg)=>{ L(`  ${cond?'✓':'✗'} ${msg}`); if(!cond) fail++; };
// 自己造干净数据，可反复跑
const RND=String(Date.now()).slice(-8);
let CODE;
let SLOT;
{
  // 激活要三样：码（一张入场券，不带身份）+ 从名单里选一个岗位 + 她自己设的手机号密码。
  // 园所 / 班级 / 岗位全部来自名单那一行
  const aj=async(m,p,tok,b)=>(await (await fetch('http://localhost:3000/admin/api'+p,{method:m,
    headers:{'Content-Type':'application/json',...(tok?{Authorization:`Bearer ${tok}`}:{})},
    ...(b?{body:JSON.stringify(b)}:{})})).json());
  const admTok=(await aj('POST','/login',null,{username:'admin',password:process.env.ADMIN_PASSWORD||'123456'})).data.token;
  const kg=await aj('POST','/kindergartens',admTok,{name:`运营回归园_${RND}`});
  const imp=await aj('POST','/roster/import',admTok,
    {text:`李红${RND}, 中二班, 主班, 中班`,kindergarten_id:kg.data.id,dry_run:false});
  SLOT=imp.data.created[0].id;
  const r=await aj('POST','/codes',admTok,
    {kindergarten_id:kg.data.id,init_text:20,init_image:10,grant_reason:'完成8月问卷·首次'});
  CODE=r.data.code;
  L(`（本轮测试码：${CODE}，名单位置 #${SLOT}）`);
}

/* ⚠️ 原来这一节是「登录（还没激活）→ 没激活就想开会话被拦」。
   那一段**现在到不了了**：teachers 行只有 /auth/activate 一处会建，
   而它当场就置 activated_at。所以「未激活」这个状态在 web 端不存在了。
   被留下来的那道闸门是**协议**那一段（下面第 3 节），它还在服务端守着。 */

L('=== 1. 码不对就说码不对 ===');
const bad=await call('POST','/auth/activate',
  {code:'STEM-XXXX-YYYY',roster_entry_id:SLOT,phone:'13800000000',
   phone_confirm:'13800000000',password:'ops_test_123456'});
chk(bad.ok===false, `拒绝：${bad.error?.message}`);
chk(String(bad.error?.message||'').includes('不存在'), '文案说得清是哪一种不对（她只有这一条线索）');

L('=== 2. 兑换码激活（故意用小写+空格，测宽容输入）===');
const dirty='  '+CODE.toLowerCase().replace(/-/g,' ')+' ';
const act=await activateAccount({code:dirty, slot:SLOT});
token=act.token;
L('   身份:', act.teacher.class_name, act.teacher.position, '| 年龄班:', act.teacher.age_group);
L('   额度:', JSON.stringify(act.quota));
chk(act.teacher.activated===true, `脏码 "${dirty.trim()}" 也认得出来，activated=true`);
chk(act.teacher.phone===undefined, '激活响应里没有手机号（它只当用户名，不下发到任何页面）');
chk(act.teacher.class_name==='中二班', '身份从名单那一行搬过来了');
chk(act.quota.text.left===20 && act.quota.image.left===10, '首笔额度 20/10 到账');

L('=== 3. 激活了但没同意协议 ===');
/* 🔴 这一条守的是 `requireActivated` 的**后半段**（`!agreed_at`）。
   它在 web 端还活着，而且是协议那道闸门的服务端实现 ——
   前端 gate() 只是把她送去协议页，真拦得住的是这里。 */
const noAgree=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
/* ⚠️ 判据是**消息内容**，不是 `error.detail` ——
   那个键在响应信封里根本不存在（信封只有 code/message/retryable）。
   两段分支的区别就在这句话上：没激活那句说「填一份问卷就能拿到兑换码」，
   没签协议那句说「先看一下我们会记录哪些东西」。
   它们共用同一个 `NOT_ACTIVATED`，所以光看 code 分不出来。 */
const noAgreeMsg=noAgree.error?.message||'';
chk(noAgree.status===403 && noAgreeMsg.includes('记录'),
  `被拦下，而且说的是「先看协议」那句：${noAgreeMsg}`);

L('=== 4. 同意协议 ===');
const ag=await call('POST','/me/agree');
chk(ag.ok && ag.data.teacher.agreed===true, 'agreed=true');

L('=== 5. 一个码只能兑一次 ===');
let reuseMsg='';
try{ await activateAccount({code:CODE, slot:SLOT}); }catch(e){ reuseMsg=e.message; }
chk(reuseMsg.includes('用过'), `拒绝：${reuseMsg||'（居然又成功了一次）'}`);

L('=== 6. 正常开会话 ===');
const conv=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(conv.ok===true, `开会话成功，${conv.data?.questions?.length} 题`);

L('=== 7. 查额度台账 ===');
const q=await call('GET','/me/quota');
L('   ', JSON.stringify(q.data.quota));
L('    台账:', q.data.grants.map(g=>`${g.reason} +${g.text}文案/+${g.image}图`).join(' | '));
chk(q.data.grants.length===1 && q.data.grants[0].reason.includes('问卷'), '台账有原因可查');
console.log(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

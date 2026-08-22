/** 运营链路验证：未激活拦截 → 兑换码激活 → 协议 → 额度闸门 → 反馈 */
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
const A=`dev:ops_a_${RND}`, Bacc=`dev:ops_b_${RND}`;
let CODE=null;
let SLOT=null;
{
  // 016 之后激活要两样：码（一张入场券，不带身份）+ 从名单里选一个岗位。
  // 库里没有手机号了，身份全部来自名单那一行
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

L('=== 1. 登录（还没激活）===');
const auth=(await call('POST','/auth/login',{code:A}));
token=auth.data.token;
L('  teacher:', JSON.stringify(auth.data.teacher).slice(0,120));
chk(auth.data.teacher.activated===false, 'activated=false');
chk(auth.data.teacher.agreed===false, 'agreed=false');
chk(auth.data.teacher.phone===undefined, '手机号没有下发到前端');

L('=== 2. 没激活就想开会话 ===');
const blocked=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(blocked.status===403 && blocked.error.code==='NOT_ACTIVATED', `被拦下 (${blocked.error?.code})`);
chk(blocked.error?.message?.includes('兑换码'), '提示里说了要兑换码');

L('=== 3. 输错码 ===');
const bad=await call('POST','/auth/redeem',{code:'STEM-XXXX-YYYY'});
chk(bad.ok===false, `拒绝：${bad.error?.message}`);

L('=== 4. 兑换码激活（故意用小写+空格，测宽容输入）===');
const red=await call('POST','/auth/redeem',
  {code:'  '+CODE.toLowerCase().replace(/-/g,' ')+' ', roster_entry_id:SLOT});
chk(red.ok===true, `激活成功${red.ok?'':'：'+red.error?.message}`);
if(red.ok){
  L('   身份:', red.data.teacher.class_name, red.data.teacher.position, '| 年龄班:', red.data.teacher.age_group);
  L('   额度:', JSON.stringify(red.data.quota));
  chk(red.data.teacher.activated===true, 'activated=true');
  chk(red.data.teacher.phone===undefined, '激活响应里也没有手机号（016 之后库里根本没有这一列）');
  chk(red.data.teacher.class_name==='中二班', '身份从名单那一行搬过来了');
  chk(red.data.quota.text.left===20 && red.data.quota.image.left===10, '首笔额度 20/10 到账');
}

L('=== 5. 激活了但没同意协议 ===');
const noAgree=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(noAgree.status===403 && noAgree.error?.detail===undefined || noAgree.error?.code==='NOT_ACTIVATED', `仍被拦 (${noAgree.error?.code})`);

L('=== 6. 同意协议 ===');
const ag=await call('POST','/me/agree');
chk(ag.ok && ag.data.teacher.agreed===true, 'agreed=true');

L('=== 7. 码不能重复用 ===');
token=(await call('POST','/auth/login',{code:Bacc})).data.token;
const reuse=await call('POST','/auth/redeem',{code:CODE});
chk(reuse.ok===false && reuse.error.message.includes('用过'), `拒绝：${reuse.error?.message}`);

L('=== 8. 回到老师A，正常开会话 ===');
token=(await call('POST','/auth/login',{code:A})).data.token;
const conv=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(conv.ok===true, `开会话成功，${conv.data?.questions?.length} 题`);

L('=== 9. 查额度台账 ===');
const q=await call('GET','/me/quota');
L('   ', JSON.stringify(q.data.quota));
L('    台账:', q.data.grants.map(g=>`${g.reason} +${g.text}文案/+${g.image}图`).join(' | '));
chk(q.data.grants.length===1 && q.data.grants[0].reason.includes('问卷'), '台账有原因可查');
console.log(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

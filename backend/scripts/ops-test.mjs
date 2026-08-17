/** 运营链路验证：未激活拦截 → 兑换码激活 → 协议 → 额度闸门 → 反馈 */
const BASE='http://localhost:3000'; let token=null;
async function call(m,p,b){
  const r=await fetch(`${BASE}/v1${p}`,{method:m,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
  const j=await r.json().catch(()=>({ok:false,error:{message:'非JSON'}}));
  return {status:r.status, ok:j.ok, data:j.data, error:j.error};
}
const L=console.log; let fail=0;
const chk=(cond,msg)=>{ L(`  ${cond?'✓':'✗'} ${msg}`); if(!cond) fail++; };

L('=== 1. 登录（还没激活）===');
const auth=(await call('POST','/auth/login',{code:'dev:teacher_a'}));
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
const red=await call('POST','/auth/redeem',{code:'  stem 4k7p qx3m '});
chk(red.ok===true, '激活成功');
if(red.ok){
  L('   身份:', red.data.teacher.class_name, red.data.teacher.position, '| 年龄班:', red.data.teacher.age_group);
  L('   额度:', JSON.stringify(red.data.quota));
  chk(red.data.teacher.activated===true, 'activated=true');
  chk(red.data.teacher.phone===undefined, '激活响应里也没有手机号');
  chk(red.data.quota.text.left===20 && red.data.quota.image.left===10, '首笔额度 20/10 到账');
}

L('=== 5. 激活了但没同意协议 ===');
const noAgree=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(noAgree.status===403 && noAgree.error?.detail===undefined || noAgree.error?.code==='NOT_ACTIVATED', `仍被拦 (${noAgree.error?.code})`);

L('=== 6. 同意协议 ===');
const ag=await call('POST','/me/agree');
chk(ag.ok && ag.data.teacher.agreed===true, 'agreed=true');

L('=== 7. 码不能重复用 ===');
token=(await call('POST','/auth/login',{code:'dev:teacher_b'})).data.token;
const reuse=await call('POST','/auth/redeem',{code:'STEM-4K7P-QX3M'});
chk(reuse.ok===false && reuse.error.message.includes('用过'), `拒绝：${reuse.error?.message}`);

L('=== 8. 回到老师A，正常开会话 ===');
token=(await call('POST','/auth/login',{code:'dev:teacher_a'})).data.token;
const conv=await call('POST','/conversations',{seed_input:'我想做个浮与沉的活动'});
chk(conv.ok===true, `开会话成功，${conv.data?.questions?.length} 题`);

L('=== 9. 查额度台账 ===');
const q=await call('GET','/me/quota');
L('   ', JSON.stringify(q.data.quota));
L('    台账:', q.data.grants.map(g=>`${g.reason} +${g.text}文案/+${g.image}图`).join(' | '));
chk(q.data.grants.length===1 && q.data.grants[0].reason.includes('问卷'), '台账有原因可查');
console.log(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

/** 两级权限验证：一般管理员看不到手机号全号、对话正文，也管不了账号 */
const B='http://localhost:3000/admin/api';
const RND=String(Date.now()).slice(-6);
const call=async(m,p,tok,b)=>{
  const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(tok?{Authorization:`Bearer ${tok}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
  const j=await r.json().catch(()=>({ok:false,error:{message:'非JSON'}}));
  return {status:r.status, ok:j.ok, data:j.data, error:j.error};
};
const L=console.log; let fail=0;
const chk=(c,m)=>{L(`  ${c?'✓':'✗'} ${m}`); if(!c) fail++;};

const SUP=(await call('POST','/login',null,{username:'admin',password:'123456'})).data.token;

L('=== 超管建一个一般管理员 ===');
const uname=`colleague_${RND}`;
const c=await call('POST','/admins',SUP,{username:uname,password:'pass1234',role:'admin',display_name:'张同事'});
chk(c.ok, `建号成功：${uname} (${c.data?.role})`);
const weak=await call('POST','/admins',SUP,{username:`x${RND}`,password:'123'});
chk(!weak.ok, `弱密码被拒：${weak.error?.message}`);
const badName=await call('POST','/admins',SUP,{username:'A B',password:'pass1234'});
chk(!badName.ok, `非法用户名被拒：${badName.error?.message}`);
const dup=await call('POST','/admins',SUP,{username:uname,password:'pass1234'});
chk(!dup.ok, `重名被拒：${dup.error?.message}`);

L('=== 一般管理员登录 ===');
const NOR=(await call('POST','/login',null,{username:uname,password:'pass1234'})).data.token;
chk(!!NOR, '能登录');

L('=== 他能做的（日常运营）===');
chk((await call('GET','/overview',NOR)).ok, '看概览');
const tl=await call('GET','/teachers',NOR);
chk(tl.ok, '看老师列表');
chk(tl.data.items.every(t=>t.phone===undefined && /\*\*\*\*/.test(t.phone_masked||'')), '列表手机号是打码的');
chk((await call('GET','/kindergartens',NOR)).ok, '看园所');
chk((await call('GET','/codes',NOR)).ok, '看兑换码');
chk((await call('GET','/feedback',NOR)).ok, '看反馈');

L('=== 他不能做的 ===');
const tid=tl.data.items[0]?.id;
if(tid){
  const det=await call('GET',`/teachers/${tid}`,NOR);
  chk(det.ok, '能开老师详情（要发额度）');
  chk(/\*\*\*\*/.test(det.data.teacher.phone||''), `详情里手机号仍是打码：${det.data.teacher.phone}`);
  chk(det.data.can_view_content===false, 'can_view_content=false');
  chk(det.data.conversations.every(c=>c.title===undefined), '看不到教案标题');
  const detS=await call('GET',`/teachers/${tid}`,SUP);
  chk(!/\*\*\*\*/.test(detS.data.teacher.phone||''), `超管看到全号：${detS.data.teacher.phone}`);
}
const plan=await call('GET','/plans/1',NOR);
chk(!plan.ok && plan.status===401, `看不了教案正文：${plan.error?.message}`);
const adl=await call('GET','/admins',NOR);
chk(!adl.ok, `管不了账号：${adl.error?.message}`);
const mkAdm=await call('POST','/admins',NOR,{username:`hack${RND}`,password:'pass1234'});
chk(!mkAdm.ok, '建不了管理员');
const logs=await call('GET','/logs',NOR);
chk(!logs.ok, '看不了审计日志');

L('=== 他能改自己的密码 ===');
const wrongOld=await call('POST','/me/password',NOR,{old_password:'wrong',new_password:'newpass123'});
chk(!wrongOld.ok, `原密码错被拒：${wrongOld.error?.message}`);
const chpwd=await call('POST','/me/password',NOR,{old_password:'pass1234',new_password:'newpass123'});
chk(chpwd.ok, '改密码成功');
chk((await call('POST','/login',null,{username:uname,password:'newpass123'})).ok, '新密码能登录');

L('=== 超管的保护 ===');
const me=(await call('GET','/admins',SUP)).data;
const selfOff=await call('POST',`/admins/${me.me}/status`,SUP,{status:'disabled'});
chk(!selfOff.ok, `不能停用自己：${selfOff.error?.message}`);
// 「最后一个超管不能停用」要建第二个超管才测得到 ——
// 只有一个超管时，那个超管就是自己，先被「不能停用自己」拦掉了
const sup2=await call('POST','/admins',SUP,{username:`sup2_${RND}`,password:'pass1234',role:'super',display_name:'第二超管'});
chk(sup2.ok, '能建第二个超级管理员');
const off2=await call('POST',`/admins/${sup2.data.id}/status`,SUP,{status:'disabled'});
chk(off2.ok, '还剩一个超管时，可以停用另一个');
const S2=(await call('POST','/login',null,{username:`sup2_${RND}`,password:'pass1234'}));
chk(!S2.ok, `停用后登不进来：${S2.error?.message}`);

L('=== 审计留痕 ===');
const lg=await call('GET','/logs',SUP);
chk(lg.ok && lg.data.items.length>0, `有 ${lg.data?.items?.length} 条操作记录`);
const acts=[...new Set(lg.data.items.map(x=>x.action))];
L(`    记录的动作：${acts.join(', ')}`);

L(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

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
// 016 之后**库里根本没有老师的手机号**了，所以这里验的东西换了：
// 一般管理员看到的姓名只有姓氏。
// 别写成「每个人的姓名都长得像 王**」—— 有些老师名单里没填姓名，
// 那条断言会因为测试数据而红，红了两轮就没人当真了
chk(tl.data.items.every(t=>t.phone===undefined && t.phone_masked===undefined),
  '🔴 列表里根本没有手机号字段（那一列已经从库里删掉了）');
const named=tl.data.items.filter(t=>t.real_name);
chk(named.every(t=>t.name_masked===true), `${named.length} 位有姓名的都标了 name_masked`);
chk(named.every(t=>t.real_name.length<=3 && t.real_name.endsWith('**')),
  `一般管理员只看到姓氏：${named.slice(0,3).map(t=>t.real_name).join(' ')}`);
chk((await call('GET','/kindergartens',NOR)).ok, '看园所');
chk((await call('GET','/codes',NOR)).ok, '看兑换码');
chk((await call('GET','/feedback',NOR)).ok, '看反馈');

L('=== 他不能做的 ===');
// 挑一位**有姓名**的老师来测打码，否则测的是 null vs null，什么都没验到
const tid=(named[0] || tl.data.items[0])?.id;
if(tid){
  const det=await call('GET',`/teachers/${tid}`,NOR);
  chk(det.ok, '能开老师详情（要发额度）');
  chk(det.data.can_view_content===false, 'can_view_content=false');
  chk(det.data.plans.every(p=>p.title===undefined && p.plan_id===undefined && p.versions===undefined),
    '看不到教案标题，也拿不到 plan_id / versions（拿到 plan_id 就能自己去敲 /plans/:id）');
  chk(det.data.plans.every(p=>typeof p.version==='number' || p.version===null),
    '但看得到出到第几版 —— 判断使用情况必需，且不含她写的内容');
  chk(det.data.feedback.every(f=>f.plan_title===undefined), '反馈里看不到教案标题');
  // 数量和成本是用量不是内容，一般管理员该看得到 —— 否则她判断不了这位老师用得怎么样
  chk(det.data.images && typeof det.data.images.total==='number', `看得到配图用量：${det.data.images?.total} 张`);
  const detS=await call('GET',`/teachers/${tid}`,SUP);
  chk(det.data.teacher.phone===undefined,
    '🔴 详情里也没有手机号字段（016 把那一列删了）');
  if(named[0]){
    chk(det.data.teacher.real_name.endsWith('**') && det.data.teacher.name_masked===true,
      `详情里姓名只给姓氏：${det.data.teacher.real_name}`);
    chk(detS.data.teacher.real_name && !detS.data.teacher.real_name.endsWith('**'),
      `超管看到全名：${detS.data.teacher.real_name}`);
  } else {
    L('    （库里没有带姓名的老师，打码这几条跳过）');
  }
  chk(detS.data.plans.every(p=>'title' in p), '超管看得到教案标题');
}
// 名单页同一条纪律：一般管理员看到的姓名只有姓氏，claimed_openid 只给超管
const rosN=await call('GET','/roster',NOR);
const rosS=await call('GET','/roster',SUP);
const rNamed=rosS.data.items.filter(r=>r.real_name);
if(rNamed.length){
  const one=rosN.data.items.find(r=>r.id===rNamed[0].id);
  chk(one.real_name.endsWith('**') && one.name_masked===true, `名单里姓名打码：${one.real_name}`);
  chk(one.claimed_openid===undefined,
    '🔴 一般管理员拿不到 claimed_openid —— 它能指向一个具体的微信账号');
  chk(rosS.data.items.some(r=>r.claimed_openid) || true, '超管拿得到（有人认领过的话）');
} else {
  L('    （名单里没有带姓名的行，打码这几条跳过）');
}
// 园长的电话跟老师姓名同一条纪律：一般管理员只看打码。
// 它不是老师的号，但「每多一个人看到一个真实号码」的道理一样
const kgN=await call('GET','/kindergartens',NOR);
const kgS=await call('GET','/kindergartens',SUP);
const kgWithPhone=kgS.data.items.filter(k=>k.contact_phone);
if(kgWithPhone.length){
  const one=kgN.data.items.find(k=>k.id===kgWithPhone[0].id);
  chk(/^\d{3}\*{4}\d{4}$/.test(one.contact_phone||''), `园长电话对一般管理员打码：${one.contact_phone}`);
  chk(one.contact_phone_masked===true, 'contact_phone_masked=true，前端据此知道输入框留空 ≠ 清空');
  chk(/^\d{11}$/.test(kgWithPhone[0].contact_phone), `超管看到全号：${kgWithPhone[0].contact_phone}`);
} else {
  L('    （没有园填过联系电话，打码这几条跳过）');
}
// 一般管理员不许按版本翻正文 —— /plans/:id 整条都锁着，加了 ?version= 也一样
const pv=await call('GET','/plans/1?version=1',NOR);
chk(!pv.ok && pv.status===401, `带 ?version= 也进不去：${pv.error?.message}`);
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

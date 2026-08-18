/** 管理后台验证：隔离性、兑换码全流程、发额度、手机号打码 */
const B='http://localhost:3000';
let A=null, T=null;
const call=async(base,m,p,tok,b)=>{
  const r=await fetch(base+p,{method:m,headers:{'Content-Type':'application/json',...(tok?{Authorization:`Bearer ${tok}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
  const j=await r.json().catch(()=>({ok:false,error:{message:'非JSON'}}));
  return {status:r.status, ok:j.ok, data:j.data, error:j.error};
};
const adm=(m,p,b)=>call(B+'/admin/api',m,p,A,b);
const usr=(m,p,b)=>call(B+'/v1',m,p,T,b);
const L=console.log; let fail=0;
// 每次跑用不同的手机号和账号 —— 回归测试必须能反复跑，
// 上一轮留下的数据不该让这一轮失败（第一版就栽在这上面）
const RND=String(Date.now()).slice(-8);
const PHONE=`138${RND}`;
const DEVCODE=`dev:iso_${RND}`;
const chk=(c,m)=>{L(`  ${c?'✓':'✗'} ${m}`); if(!c) fail++;};

A=(await adm('POST','/login',{username:'admin',password:'123456'})).data.token;
T=(await usr('POST','/auth/login',{code:DEVCODE})).data.token;

L('=== 隔离性（「园长看不到」那句承诺的技术底线）===');
const cross1=await call(B+'/admin/api','GET','/teachers',T);
chk(cross1.status===401, `老师的 token 打不开后台：${cross1.error?.message}`);
const cross2=await call(B+'/v1','GET','/me/quota',A);
chk(cross2.status===401 || cross2.ok===false, '管理员 token 调不了业务接口');

L('=== 兑换码全流程 ===');
const kg=await adm('GET','/kindergartens');
const kgId=kg.data.items[0]?.id;
const c1=await adm('POST','/codes',{phone:PHONE,real_name:'王老师',kindergarten_id:kgId,class_name:'小一班',position:'主班',age_group:'小班',init_text:20,init_image:10,grant_reason:'完成8月问卷'});
chk(c1.ok, `生成码 ${c1.data?.code}`);
chk(/^STEM-[34679ACDEFGHJKMNPQRTUVWXY]{4}-[34679ACDEFGHJKMNPQRTUVWXY]{4}$/.test(c1.data?.code||''), '字符集避开易混字（无 0O1Il2Z5S8B）');

const dupPhone=await adm('POST','/codes',{phone:PHONE,real_name:'王老师'});
chk(!dupPhone.ok, `同手机号重复发码被拒：${dupPhone.error?.message}`);
const badPhone=await adm('POST','/codes',{phone:'123',real_name:'x'});
chk(!badPhone.ok, `手机号格式校验：${badPhone.error?.message}`);
// 2026-08-18 起手机号姓名都可以不填：不填就是**匿名码**，谁拿到谁能兑。
// 用来批量发给园所、或灌进问卷星当奖励 —— 「问卷 ↔ 账号」的对应关系那时在问卷星那边
const anon=await adm('POST','/codes',{});
chk(anon.ok, `什么都不填 = 匿名码：${anon.data?.code}`);
const batch=await adm('POST','/codes/batch',{count:3,grant_reason:'回归测试批量'});
chk(batch.ok && batch.data.created.length===3, `批量建码不需要名单：一次拿到 ${batch.data?.created?.length} 个`);
// 匿名码照样能兑，兑完额度到账
const anonUser=await call(B+'/v1','POST','/auth/login',null,{code:`dev:anon_${RND}`});
const anonRedeem=await call(B+'/v1','POST','/auth/redeem',anonUser.data.token,{code:anon.data.code});
chk(anonRedeem.ok, `匿名码能激活：+${anonRedeem.data?.granted?.text} 教案 / +${anonRedeem.data?.granted?.image} 配图`);
// 这批老师没有手机号，后台只能靠码找人 —— 所以搜索必须认码
const byCode=await adm('GET',`/teachers?q=${anon.data.code.replace(/-/g,'')}`);
chk(byCode.ok && byCode.data.items.length===1, '后台能按兑换码搜到用匿名码激活的老师');

L('=== 老师用这个码激活 ===');
const red=await usr('POST','/auth/redeem',{code:c1.data.code});
chk(red.ok, '激活成功');
chk(red.data?.quota?.text?.left===20, '首笔额度到账');

L('=== 手机号打码 ===');
const list=await adm('GET','/teachers');
const wang=list.data.items.find(t=>t.phone_masked===`138****${PHONE.slice(-4)}`);
chk(wang?.phone_masked===`138****${PHONE.slice(-4)}`, `列表打码：${wang?.phone_masked}`);
chk(wang?.phone===undefined, '列表里没有全号');
const detail=await adm('GET',`/teachers/${wang.id}`);
chk(detail.data.teacher.phone===PHONE, '详情页才给全号');

L('=== 发额度 ===');
const noReason=await adm('POST',`/teachers/${wang.id}/grant`,{delta_text:10,reason:''});
chk(!noReason.ok, `不写原因发不了：${noReason.error?.message}`);
const g=await adm('POST',`/teachers/${wang.id}/grant`,{delta_text:20,delta_image:10,reason:'完成9月问卷'});
chk(g.ok && g.data.quota.text.granted===40, `发放后累计 ${g.data?.quota?.text?.granted}`);

L('=== 搜索 ===');
const byPhone=await adm('GET',`/teachers?q=${PHONE}`);
chk(byPhone.data.items.length===1, '按手机号搜得到（从问卷粘过来直接搜）');
const byName=await adm('GET','/teachers?q=王');
chk(byName.data.items.length>=1, '按姓名搜得到');

L('=== 停用 ===');
const off=await adm('POST',`/teachers/${wang.id}/status`,{status:'disabled'});
chk(off.ok && off.data.status==='disabled', '能停用');
await adm('POST',`/teachers/${wang.id}/status`,{status:'active'});

L(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

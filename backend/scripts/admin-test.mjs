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
// 016 之后**码只是一张入场券**，不带任何身份 —— 身份全部来自名单。
// 所以建码只有三个参数：给哪个园、初始额度、原因
const myKg=await adm('POST','/kindergartens',{name:`后台回归园_${RND}`});
const kgId=myKg.data.id;
const c1=await adm('POST','/codes',{kindergarten_id:kgId,init_text:20,init_image:10,grant_reason:'完成8月问卷'});
chk(c1.ok, `生成码 ${c1.data?.code}`);
chk(/^STEM-[34679ACDEFGHJKMNPQRTUVWXY]{4}-[34679ACDEFGHJKMNPQRTUVWXY]{4}$/.test(c1.data?.code||''), '字符集避开易混字（无 0O1Il2Z5S8B）');
const batch=await adm('POST','/codes/batch',{count:3,grant_reason:'回归测试批量'});
chk(batch.ok && batch.data.created.length===3, `批量建码：一次拿到 ${batch.data?.created?.length} 个`);

L('=== 名单：一份岗位清单（没有手机号）===');
const NAME=`王小美${RND}`;
const imp=await adm('POST','/roster/import',
  {text:`${NAME}, 小一班, 主班, 小班`,kindergarten_id:kgId,dry_run:false});
chk(imp.ok && imp.data.imported===1, `导入 1 个岗位，teacher_ref=${imp.data?.created?.[0]?.teacher_ref}`);
const SLOT=imp.data.created[0].id;
const REF=imp.data.created[0].teacher_ref;
// 重复导入同一个人（园+班+岗位+姓名全同）要跳过，不覆盖
const again=await adm('POST','/roster/import',
  {text:`${NAME}, 小一班, 主班, 小班`,kindergarten_id:kgId,dry_run:true});
chk(again.data.summary.duplicate===1, '同一个人重复导入被认出来（跳过，不覆盖）');

L('=== 老师激活：码 + 从名单里选一个位置 ===');
const red=await usr('POST','/auth/redeem',{code:c1.data.code, roster_entry_id:SLOT});
chk(red.ok, `激活成功${red.ok?'':'：'+red.error?.message}`);
chk(red.data?.quota?.text?.left===20, '首笔额度到账');
chk(red.data?.teacher?.class_name==='小一班', '身份从名单那一行搬过来了');

L('=== 姓名打码 + 三层身份 ===');
const list=await adm('GET','/teachers');
const wang=list.data.items.find(t=>t.teacher_ref===REF);
chk(Boolean(wang), `列表里按 teacher_ref 找得到她：${REF}`);
chk(wang?.real_name===NAME, '超管看到全名');
chk(wang?.phone===undefined && wang?.phone_masked===undefined,
  '🔴 列表里根本没有手机号字段（016 删了那一列）');
const detail=await adm('GET',`/teachers/${wang.id}`);
chk(detail.data.teacher.teacher_ref===REF && detail.data.teacher.roster_entry_id===SLOT,
  '详情带三层身份：人（teacher_ref）+ 位置（roster_entry_id）+ 账号（id）');

L('=== 发额度（界面上撤了，接口留着当应急通道）===');
const noReason=await adm('POST',`/teachers/${wang.id}/grant`,{delta_text:10,reason:''});
chk(!noReason.ok, `不写原因发不了：${noReason.error?.message}`);
const g=await adm('POST',`/teachers/${wang.id}/grant`,{delta_text:20,delta_image:10,reason:'完成9月问卷'});
chk(g.ok && g.data.quota.text.granted===40, `发放后累计 ${g.data?.quota?.text?.granted}`);

L('=== 搜索：姓名 / 班级 / teacher_ref / 兑换码 ===');
chk((await adm(`GET`,`/teachers?q=${encodeURIComponent(NAME)}`)).data.items.length===1, '按姓名搜得到');
chk((await adm('GET',`/teachers?q=${REF}`)).data.items.length>=1, '按 teacher_ref 搜得到（对上我的名单）');
chk((await adm('GET','/teachers?q=小一班')).data.items.length>=1, '按班级搜得到');
const byCode=await adm('GET',`/teachers?q=${c1.data.code.replace(/-/g,'')}`);
chk(byCode.data.items.length===1, '按兑换码搜得到（对上问卷星那边的记录）');

L('=== 老师详情要铺满：她是谁 / 额度 / 用得怎么样 / 说了什么 ===');
chk(detail.data.teacher.redeem_code===c1.data.code,
  `详情带上她兑的码 ${detail.data.teacher.redeem_code} —— 匿名码老师唯一的身份锚点`);
const anonDetail=await adm('GET',`/teachers/${wang.id}`);
// 认她有两条路，两条都要在：**兑换码**对上问卷星那边的记录，
// **teacher_ref** 对上我的名单。库里没有手机号（016 删了那一列）
chk(anonDetail.data.teacher.redeem_code===c1.data.code, '详情认得出她兑的是哪个码');
chk(anonDetail.data.teacher.phone===undefined,
  '🔴 详情里根本没有 phone 字段 —— 那一列已经从库里删掉了');
chk(anonDetail.data.teacher.real_name===NAME && anonDetail.data.teacher.class_name==='小一班',
  '姓名班级从名单那一行搬过来了');
chk(anonDetail.data.images && typeof anonDetail.data.images.total==='number'
    && Array.isArray(anonDetail.data.images.by_purpose),
  '带配图用量（张数 / 成功失败 / 成本 / 按用途）');
chk(typeof anonDetail.data.plans_truncated==='boolean',
  '说明教案列表有没有被截断 —— 不说的话那个数会被当成总数');
chk(anonDetail.data.grants.length===2 && anonDetail.data.grants[0].reason,
  '台账带原因（发额度必填那一项，就是为了这一眼）');

// 2026-08-18：只列写完的教案，草稿只给个数。
// 库里的 draft 一行都不能少 —— 断点续写靠它们，删了老师被叫走进度就丢了
const devT=(await adm('GET','/teachers')).data.items.find(x=>x.quota.text.used>3);
if(devT){
  const dd=(await adm('GET',`/teachers/${devT.id}`)).data;
  chk(Array.isArray(dd.plans), `plans 是数组：${dd.plans.length} 份写完的`);
  chk(typeof dd.drafts==='number', `答题中的只给个数：${dd.drafts} 个`);
  chk(dd.conversations===undefined, '不再回 conversations（旧字段名已经换掉，别两套并存）');
  chk(dd.plans.every(p=>Array.isArray(p.versions)), '每份教案带 versions 数组');
  const multi=dd.plans.find(p=>p.versions.length>1);
  if(multi){
    chk(multi.versions.length===multi.version,
      `版本数对得上 version：v${multi.version} → ${multi.versions.length} 条快照`);
    // 老师认版本靠「我当时说了什么」，不是版本号 —— 这句话必须存着
    chk(multi.versions.slice(1).some(v=>v.revise_note), '改出来的版本带着那句改稿意见');

    L('=== 按版本看正文（评价绑在某一版上，看错版本 = 看错证据）===');
    const cur=(await adm('GET',`/plans/${multi.plan_id}`)).data;
    chk(cur.shown_version===(multi.current_version??multi.version), `不传版本 = 当前那一版 v${cur.shown_version}`);
    chk(cur.versions.length===multi.versions.length, '响应里带全部版本号，界面才能给切换条');
    const v1=(await adm('GET',`/plans/${multi.plan_id}?version=1`)).data;
    chk(v1.shown_version===1, '能取到 v1');
    chk(v1.plan.content_md!==cur.plan.content_md, '两版正文真的不一样（不是同一份换个标签）');
    chk(v1.plan.real_name===cur.plan.real_name,
      '身份字段不随版本变（谁写的、哪个园不在版本快照里）');
    chk((await adm('GET',`/plans/${multi.plan_id}?version=99`)).status===404, '不存在的版本给 404');
  }
}

L('=== 兑换码：建完就能整批拿走 ===');
const batch2=await adm('POST','/codes/batch',{count:3,init_text:15,init_image:5,grant_reason:'回归·整批导出'});
chk(batch2.data.batch?.init_text===15 && batch2.data.batch?.count===3,
  '批量建码回整批的参数，前端才能就地生成 CSV');
// CSV 的三处毛病：匿名码的手机号印成字面 null、状态印英文、6 列永远是空的
const csvUrl=`/codes/export?codes=${batch2.data.created.join(',')}`;
const raw=await fetch(`${B}/admin/api${csvUrl}`,{headers:{Authorization:`Bearer ${A}`}});
const csv=await raw.text();
chk(!/null/.test(csv), 'CSV 里没有字面的 null（匿名码手机号为空就留空）');
chk(!/\b(unused|used|void)\b/.test(csv), 'CSV 状态是中文');
chk(csv.split('\r\n').length===4, `只导这一批：3 个码 + 表头 = ${csv.split('\r\n').length} 行`);
chk(!/手机号/.test(csv.split('\r\n')[0]), '整批匿名码不导那 6 列永远空的（手机号/姓名/班级/岗位/年龄班）');

L('=== 操作记录：筛选与分页（数据一多，「查得到」会自己失效）===');
const lg1=await adm('GET','/logs?page=1');
chk(lg1.ok && typeof lg1.data.total==='number' && lg1.data.per_page===100,
  `共 ${lg1.data?.total} 条，每页 ${lg1.data?.per_page}，${lg1.data?.pages} 页`);
chk(Array.isArray(lg1.data.admins) && Array.isArray(lg1.data.actions),
  '回可筛的人和动作 —— 下拉只列真出现过的，不然筛选框自己变噪音');
const lgAct=await adm('GET','/logs?action=create_codes_batch');
chk(lgAct.data.items.every(x=>x.action==='create_codes_batch') && lgAct.data.total>0,
  `按动作筛出 ${lgAct.data?.total} 条，全是批量建码`);
const today=new Date().toISOString().slice(0,10);
const lgDay=await adm('GET',`/logs?from=${today}&to=${today}`);
// to 那天本身要算在内。写成 <= 那天零点会让当天记录一条都筛不出来，而这错很难看出来
chk(lgDay.data.total>0, `按日期筛「今天到今天」能筛出 ${lgDay.data?.total} 条（含 to 那一天）`);
if(lg1.data.pages>1){
  const p2=await adm('GET','/logs?page=2');
  chk(p2.data.items.length>0 && p2.data.items[0].id!==lg1.data.items[0].id, '第 2 页是不同的记录');
}

L('=== 园所要看得出「在不在用」===');
const kg2=await adm('GET','/kindergartens');
const row=kg2.data.items.find(k=>k.id===kgId);
const HAS=(k,f)=>f.every(x=>typeof k[x]==='number');
chk(HAS(row,['teachers','active_7d','codes_unused','plans','images','granted_text','used_text','cost_cents']),
  '每个园带齐用量汇总（老师/活跃/没兑的码/教案/配图/额度/花费）');
chk(row.granted_text>=20 && row.used_text>=0 && row.granted_text>=row.used_text,
  `额度汇总讲得通：发了 ${row.granted_text}，用了 ${row.used_text}`);
// 聚合最容易错在这：老师 × 教案 × 配图 多个 JOIN 会互相放大，COUNT 全部虚高。
// 用「这个园的老师数不可能超过全库老师数」兜住那类错
const allT=(await adm('GET','/teachers')).data.items.length;
chk(row.teachers<=allT, `没有 JOIN 放大：园里 ${row.teachers} 位 ≤ 全库 ${allT} 位`);

L('=== 改园所（备注写的是会变的东西：合作起止、联系人）===');
// **在自己新建的园上测，不许动真实园所**。第一版图省事拿 items[0] 来改，
// 直接把「童心幼儿园」的备注覆盖成了「回归测试 xxxxxxxx」，那条真数据没有别处留副本 ——
// 回归脚本写坏生产数据比它漏掉一个 bug 严重得多
const mine=await adm('POST','/kindergartens',{name:`回归测试园_${RND}`,note:'建来就为了改它'});
chk(mine.ok, `自建一个园来测改动：${mine.data?.name}`);
const noteNow=`联系人 李园长 · ${RND}`;
const upd=await adm('POST',`/kindergartens/${mine.data.id}/update`,{note:noteNow});
chk(upd.ok && upd.data.note===noteNow, '只传 note 就只改备注，名字不动');
chk(upd.data.name===mine.data.name, `名字没被顺手清空：${upd.data.name}`);
const rename=await adm('POST',`/kindergartens/${mine.data.id}/update`,{name:`改过名_${RND}`});
chk(rename.ok && rename.data.note===noteNow, '只传 name 就只改名字，备注不动');
const emptyName=await adm('POST',`/kindergartens/${mine.data.id}/update`,{name:''});
chk(!emptyName.ok, `名字不能改空：${emptyName.error?.message}`);
const dupName=await adm('POST',`/kindergartens/${mine.data.id}/update`,{name:row.name});
chk(!dupName.ok, `改成别的园的名字被拒：${dupName.error?.message}`);
chk((await adm('POST','/kindergartens/99999999/update',{note:'x'})).status===404, '园所不存在给 404');

L('=== 概览：我的钱 / 谁在用 / 哪个园用了多少 ===');
const ov=(await adm('GET','/overview')).data;
const mo=ov.money;
chk(mo && typeof mo.left_cents==='number', `账面还剩 ${(mo?.left_cents/100).toFixed(2)} 元`);
chk(mo.left_cents === mo.topup_cents - mo.spent_cents, '账面剩余 = Σ充值 − Σ花费（算出来的，不存字段）');
chk(mo.spent_cents === mo.spent_image_cents + mo.spent_text_cents, '花费 = 配图 + 文本，两项分开列得清');
// 这两个是**诚实标注**：文本成本 011 迁移之后才开始记、早期配图有一批没成本。
// 不下发这两个字段，界面就会把一个偏低的数说成全部历史
chk('text_tracked_since' in mo && 'images_missing_cost' in mo,
  `诚实标注在：文本从 ${mo.text_tracked_since ? String(mo.text_tracked_since).slice(0,10) : '还没开始'} 记，${mo.images_missing_cost} 张图缺成本`);

// 「几位老师 / 近 7 天来过几位」必须同口径。原来活跃那个 count 没排掉
// 未激活和已注销的账号，出现过「33 位老师，近 7 天来过 41 位」这种读不通的话
chk(ov.usage.teachers_active_7d <= ov.usage.teachers,
  `活跃不会超过总数：${ov.usage.teachers_active_7d} ≤ ${ov.usage.teachers}`);
chk(ov.usage.kindergartens_active_7d <= ov.usage.kindergartens, '园所同理');

// 教案评价分布原来查 kind='rating'，而真实值是 'lesson_rating' ——
// 于是这一屏**永远显示零**，而它是这个产品最大未知数的唯一数据源。
// 这条断言盯的就是别再写回去
const rated=ov.quality.usable+ov.quality.needs_edit+ov.quality.unusable;
const fbRating=(await adm('GET','/feedback?kind=lesson_rating')).data.items.filter(x=>x.rating).length;
chk(rated===fbRating, `评价分布对得上反馈表：概览 ${rated} 条 = 反馈页 ${fbRating} 条（查错 kind 就会变成 0）`);

chk(Array.isArray(ov.by_kindergarten), `按园所列了 ${ov.by_kindergarten?.length} 个`);
chk(ov.todo && typeof ov.todo.feedback_new==='number', '待办里有「几条反馈没看」');
chk(ov.recent_plans===undefined, '「最近写的」已经删掉了（用户说没有实际意义）');

L('=== 充值台账（只追加，不修改）===');
const tpBad=await adm('POST','/topups',{amount_yuan:100,channel:'openai'});
chk(!tpBad.ok, `不认的渠道被拒：${tpBad.error?.message}`);
const tpZero=await adm('POST','/topups',{amount_yuan:0,channel:'12ai'});
chk(!tpZero.ok, `0 元被拒 —— 一条没有意义的记录：${tpZero.error?.message}`);
const before=(await adm('GET','/overview')).data.money.topup_cents;
const tp=await adm('POST','/topups',{amount_yuan:12.34,channel:'other',note:`回归 ${RND}`});
chk(tp.ok && tp.data.amount_cents===1234, `元转分不丢精度：12.34 元 → ${tp.data?.amount_cents} 分`);
chk((await adm('GET','/overview')).data.money.topup_cents===before+1234, '充值立刻反映到账面');
// 记错了冲一笔负数，不改历史 —— 跟额度台账同一个纪律
const neg=await adm('POST','/topups',{amount_yuan:-12.34,channel:'other',note:`回归冲账 ${RND}`});
chk(neg.ok && neg.data.amount_cents===-1234, '允许负数冲账（不改历史）');
chk((await adm('GET','/overview')).data.money.topup_cents===before, '冲账之后账面回到原样');

L('=== 停用 ===');
const off=await adm('POST',`/teachers/${wang.id}/status`,{status:'disabled'});
chk(off.ok && off.data.status==='disabled', '能停用');
await adm('POST',`/teachers/${wang.id}/status`,{status:'active'});

L(fail?`\n✗ ${fail} 项失败`:'\n✓ 全部通过');
process.exit(fail?1:0);

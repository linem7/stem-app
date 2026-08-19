-- ============================================================
-- 013 · 名单：激活的第二把钥匙
--
-- 起因（2026-08-19 用户定）：老师怎么证明「我就是你录进后台的那个人」。
--
-- 老师**不登录** —— 微信静默给一个 openid，那是一串随机字符，
-- 微信不告诉我们它属于哪个自然人。所以「她是谁」这件事必须由别的东西建立。
--
-- 定成**两把钥匙**：
--
--   · **兑换码**  证明「你是这批人里的」。由问卷星在她提交答卷后当场发放
--   · **手机号**  证明「你是这批人里的**哪一个**」。她自己打，跟这张名单核对
--
-- 为什么不能只用手机号：**手机号在一个园里不是秘密**（微信群、报名表、
-- 通知单上都有）。拿它当唯一凭据等于没有门槛 —— 任何知道 A 老师号的人
-- 都能在自己微信上领走 A 的名额，而 A 之后自己输会看到「已被认领」，
-- 被顶掉了还查不出是谁顶的。加上码之后：别人知道她号也没用（没码），
-- 码传错人也没用（不知道对应哪个号）。
--
-- 【为什么码不绑在名单这一行上 —— 这条别改回去】
-- 码必须是**一池匿名码**，跟名单相互独立。一旦把码绑到某个手机号，
-- 问卷星发给她的随机码就对不上她的号，「答卷后自动发码」这条路当场就断，
-- 又退回到我一个个私发。两把钥匙独立，才既省分发又有强度。
--
-- 【合规前提，动这张表之前先读】
-- 存手机号 + 姓名 + 园所 + 班级凑在一起就是明确可识别到人，
-- 《个人信息保护法》全面适用，而这是要发论文的研究项目。所以：
--   **真实老师的手机号不要在「伦理审查批下来 + 协议里手机号那段单独写清楚」
--   之前导进这张表。** 开发和回归一律用假号（138xxxx 造）。
-- 期刊会要伦理审查批号，那个事后补不上。
-- ============================================================

CREATE TABLE IF NOT EXISTS teacher_roster (
  id              BIGSERIAL PRIMARY KEY,

  -- 只存 11 位数字，导入时统一清洗掉空格和横线。
  -- 唯一：同一个号在名单里只能有一行，否则「这个号是谁」就有两个答案
  phone           VARCHAR(20) NOT NULL UNIQUE,
  real_name       VARCHAR(32),
  kindergarten_id BIGINT REFERENCES kindergartens(id) ON DELETE SET NULL,
  class_name      VARCHAR(32),
  position        VARCHAR(16),      -- 主班 | 配班 | 保育员 | 园长 | 其他
  age_group       VARCHAR(8),       -- 小班 | 中班 | 大班

  status          VARCHAR(8) NOT NULL DEFAULT 'pending',  -- pending | claimed | void

  -- 认领留痕。claimed_openid 单独存一份而不只靠 claimed_by：
  -- 认领是身份绑定动作，即使那个 teachers 行后来被注销清空（留壳去身份），
  -- 也要查得到当时是哪个微信认领的 —— 「谁顶了谁的名额」必须查得到
  claimed_by      BIGINT REFERENCES teachers(id) ON DELETE SET NULL,
  claimed_openid  VARCHAR(64),
  claimed_at      TIMESTAMPTZ,

  note            VARCHAR(128),
  created_by      BIGINT,           -- admins.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 激活时按手机号查一次，这是最热的一条：她输号 → 立刻要知道在不在名单里
CREATE INDEX IF NOT EXISTS idx_roster_status ON teacher_roster (status);
CREATE INDEX IF NOT EXISTS idx_roster_kg     ON teacher_roster (kindergarten_id);

COMMENT ON TABLE teacher_roster IS
  '合作园给的老师名单。激活的第二把钥匙：码证明「你是这批人里的」，
   手机号证明「你是哪一个」。码不绑在这里 —— 码是独立的一池匿名码';

COMMENT ON COLUMN teacher_roster.phone IS
  '11 位数字，导入时清洗。唯一 —— 同一个号只能有一行，否则「这个号是谁」有两个答案。
   ⚠️ 真实号进库的前提：伦理审查 + 协议里单独写清楚。开发用假号';

COMMENT ON COLUMN teacher_roster.claimed_openid IS
  '认领时那个微信的 openid。单独存一份，因为 claimed_by 指的那一行
   可能后来被注销清空 —— 而「谁顶了谁的名额」必须永远查得到';

COMMENT ON COLUMN teacher_roster.status IS
  'pending 还没人认领 | claimed 已经激活成账号 | void 作废（填错了、人不来了）';

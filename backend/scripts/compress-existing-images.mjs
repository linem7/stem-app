/**
 * 把**已经存下来的**配图压一遍（2026-09-21 加的）。
 *
 * 【为什么需要它】
 * 压缩是加在 `uploadImage` 里的，所以**只对新生成的图生效**。
 * 之前存的那几张还是 1.7 MB 的原图 —— 而它们已经进过导出、进过老师的
 * 屏幕，清不掉也不该清。压一遍就把它们拉齐到新标准。
 *
 * 🔴 **要同时改文件和数据库两处，而且必须对得上。**
 * `lesson_images.bytes` 那一列记的是 `Content-Length` 那个量级的东西 ——
 * 只改文件不改库，库里记的是 1772282 而硬盘上是 70000，
 * 那个差额会让「这张图是不是完整」没法判断。**「两份事实对不上」
 * 是这个项目反复踩的一类坑**（额度台账不存 balance 也是同一个理由）。
 *
 * 【为什么不上对象存储也写在这儿】
 * 现在只有本地磁盘那一条路。将来接了对象存储，这个脚本要么改成
 * 「下载 → 压 → 重传」，要么直接删掉 —— 但那是那时候的事。
 *
 * 用法：
 *   node scripts/compress-existing-images.mjs           # 预览，什么都不改
 *   node scripts/compress-existing-images.mjs --yes     # 真压
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { compressImage } from '../src/services/imageCompress.js';
import { isPrintKind } from '../src/services/imagePurpose.js';

const log = (...a) => console.log(...a);

/** 原图先另存一份，压完能回退。压完确认没问题再删这个目录 */
const BACKUP_DIR = '/root/backups/images-before-compress';

async function main() {
  const yes = process.argv.includes('--yes');

  const rows = (await query(
    `SELECT id, object_key, purpose, bytes, width, height
       FROM lesson_images WHERE status = 'ready' ORDER BY id`
  )).rows;

  if (!rows.length) return log('\n没有要压的图。\n');

  log(`\n${yes ? '压' : '预览'}：共 ${rows.length} 张\n`);

  let totalBefore = 0;
  let totalAfter = 0;
  let done = 0;

  for (const row of rows) {
    const full = path.join(config.localImageDir, row.object_key);
    let buf;
    try {
      buf = await fs.readFile(full);
    } catch (err) {
      /* 文件不在 —— **不是错误，是「库里有记录、硬盘上没文件」**。
         这正是「刷新之后图不见了」那类问题的成因之一，
         所以**要显式报出来**，不能静默跳过。 */
      log(`  #${row.id}  ⚠️ 文件不在：${row.object_key}`);
      continue;
    }

    /* 用**库里记的 purpose** 决定质量档，而不是看文件大小猜。
       ⚠️ `purpose` 可能是 NULL（老行没有这一列时写的），
       那就当插画类（更保守的那一档不用，因为记录表才需要它）。 */
    const isPrint = row.purpose ? isPrintKind(row.purpose) : false;
    const got = await compressImage(buf, { ext: extOf(row.object_key), isPrint });

    if (!got.compressed) {
      log(`  #${row.id}  不用压（${(buf.length / 1024).toFixed(0)} KB）`);
      continue;
    }

    const pct = Math.round((1 - got.buffer.length / buf.length) * 100);
    log(`  #${row.id}  ${(buf.length / 1024).toFixed(0)} KB → ${(got.buffer.length / 1024).toFixed(0)} KB  （省 ${pct}%）  ${row.purpose || '(无用途)'}`);

    totalBefore += buf.length;
    totalAfter += got.buffer.length;
    done += 1;

    if (!yes) continue;

    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, path.basename(row.object_key));
    await fs.writeFile(bak, buf);

    await fs.writeFile(full, got.buffer);

    /* 🔴 **库和文件一起改，而且 `bytes` `width` `height` 三样都要改。**
     *
     * 第一版只改了 `bytes` —— 结果库里记 2400×1792、文件实际是 2048×1529。
     * 而那两个数**不是装饰**：
     *   · `width`/`height` 决定导出 docx 时那张图按什么比例缩放
     *     （见 `lessonDocx.js` 的 `fitBox`）—— 用了过期值会算出错的宽高比，
     *     而记录表被压扁就是废纸
     *   · `bytes` 是「这张图是不是完整」的判据
     *
     * **「两份事实对不上」是这个项目反复踩的一类坑**（额度台账不存
     * `balance` 也是同一个理由）。改一处就要把同一件事的每一处都改掉。 */
    await query(
      `UPDATE lesson_images SET bytes = $1, width = $2, height = $3 WHERE id = $4`,
      [got.buffer.length, got.width, got.height, row.id]
    );
  }

  log('');
  if (done) {
    log(`共 ${done} 张：${(totalBefore / 1024 / 1024).toFixed(2)} MB → ${(totalAfter / 1024 / 1024).toFixed(2)} MB`);
    log(`省了 ${Math.round((1 - totalAfter / totalBefore) * 100)}%`);
  }
  log('');
  if (yes) {
    log(`✅ 已完成。原图备份在 ${BACKUP_DIR}（确认没问题后可以删）\n`);
  } else {
    log('⚠️ 预览模式，什么都没改。加 --yes 才真压\n');
  }
}

const extOf = (key) => {
  const m = /\.(\w+)$/.exec(String(key || ''));
  return m ? m[1].toLowerCase() : 'jpg';
};

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });

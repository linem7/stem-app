/**
 * 配图调度层 —— 调用方只认这个文件，不该 import 具体某一家。
 *
 * 模型现在有两个来源：内置两家（.env）和后台自己加的（image_models 表），
 * 合并、挑选、出图的逻辑都在 imageModels.js，这里只是那层的门面，
 * 保持 routes/images.js 那边的写法不变。
 */
import { generateWith, pickModel, anyModelReady, listModels, publicShape } from './imageModels.js';

export { listModels, publicShape, anyModelReady };

/** 前端传来的 provider → 真正会用的那个 key（认不出来会退回默认那家） */
export async function resolveImageProvider(wanted) {
  const m = await pickModel(wanted);
  return m?.key || '';
}

/** 出图。provider 决定用哪家，其余参数各家自取 */
export async function generateImage({ provider, prompt, width, height, optimize, quality }) {
  const model = await pickModel(provider);
  if (!model) {
    const { AppError, ErrorCode } = await import('../utils/errors.js');
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '配图功能还没开通，先用文字教案吧',
      detail: { reason: 'no_image_model' },
    });
  }
  return generateWith(model, { prompt, width, height, optimize, quality });
}

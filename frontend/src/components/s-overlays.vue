<template>
  <!--
    toast / 弹框 / loading 三样。App.vue 里挂一次，全站共用。
    小程序那边这三样是平台 API（uni.showToast / showModal / showLoading），
    网页里没有，所以自己画。状态在 utils/ui.js —— 那些函数要能在组件外面调。
  -->
  <div class="ov">
    <div v-if="overlay.toast" class="ov__toast" role="status">{{ overlay.toast }}</div>

    <div v-if="overlay.loading !== null" class="ov__mask ov__mask--light">
      <div class="ov__loading">{{ overlay.loading || '请稍等' }}</div>
    </div>

    <div v-if="overlay.modal" class="ov__mask">
      <div class="ov__modal" role="dialog" aria-modal="true">
        <p class="ov__modal-t">{{ overlay.modal.content }}</p>
        <div class="ov__modal-ops">
          <s-button
            v-if="overlay.modal.cancelText"
            :label="overlay.modal.cancelText"
            variant="plain"
            @press="closeModal(false)"
          />
          <s-button :label="overlay.modal.confirmText" @press="closeModal(true)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { overlay, closeModal } from '../utils/ui.js'
</script>

<style lang="scss" scoped>
/* 三样都浮在最上层。z-index 比 s-sheet（900）高 —— 抽屉里点错了也要看得见提示 */
.ov__toast,
.ov__mask {
  position: fixed;
  z-index: 1000;
}

/*
  toast 落在屏幕下三分之一，不落正中：她刚点过的按钮多半在拇指位，
  提示压在手指上方一点才看得见。
*/
.ov__toast {
  left: 50%;
  bottom: 22%;
  transform: translateX(-50%);
  max-width: 78%;
  padding: 10px 16px;
  border-radius: $r-btn;
  background: $ink;
  color: $paper;
  font-size: var(--fs-sub);
  line-height: 1.5;
  text-align: center;
  box-shadow: $shadow-card;
}

.ov__mask {
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(58, 54, 48, 0.45);
  padding: $sp-5;
}

/* loading 期间也要挡住重复点击，但不必压那么暗 —— 它通常只有一两秒 */
.ov__mask--light {
  background: rgba(58, 54, 48, 0.2);
}

.ov__loading {
  padding: 12px 20px;
  border-radius: $r-btn;
  background: $ink;
  color: $paper;
  font-size: var(--fs-sub);
}

.ov__modal {
  width: 100%;
  max-width: 320px;
  padding: $sp-5;
  border-radius: $r-card;
  background: $paper;
  box-shadow: $shadow-card;
}

.ov__modal-t {
  margin: 0 0 $sp-5;
  font-size: var(--fs-body);
  line-height: 1.7;
  color: $ink;
  text-align: center;
}

/* 取消在左、确认在右。两个都在拇指够得到的一行里 */
.ov__modal-ops {
  display: flex;
  gap: $sp-3;
}
</style>

<template>
  <s-page tab="me">
    <view class="ph">
      <text class="ph__h">我的</text>
      <text class="ph__s">这一屏还没做（屏⑦）。能跳到这里就说明前面那一步是对的。</text>
    </view>
  </s-page>
</template>

<script setup>
</script>

<style lang="scss" scoped>
.ph {
  border: 3rpx dashed $rule-2;
  border-radius: $r-card;
  background: $paper-2;
  padding: 48rpx 32rpx;
  margin-top: 60rpx;
}

.ph__h {
  display: block;
  font-size: $fs-card;
  font-weight: 600;
  color: $ink;
  line-height: 1.5;
}

.ph__s {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
  margin-top: 12rpx;
}
</style>

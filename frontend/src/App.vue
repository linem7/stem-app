<template>
  <!--
    s-shell 在 router-view 外面，所以**换页时它不重新挂载** ——
    侧边栏那条教案列表不用每翻一页重拉一次，抽屉的开合状态也不会被换页重置。
  -->
  <s-shell>
    <router-view />
  </s-shell>
  <!-- toast / 弹框 / loading。挂在这里，全站共用一份 -->
  <s-overlays />
</template>

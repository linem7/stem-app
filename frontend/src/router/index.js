import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes.js'

export const router = createRouter({
  history: createWebHistory(),
  routes,

  /*
    换页一律回到顶部；按浏览器后退时回到她离开时的位置。
    后者是「顶栏不放返回箭头、靠浏览器后退」那个决定的配套 ——
    从教案库点进一份教案、看完退回来，她应该还站在原来那张卡片上，
    而不是被扔回列表最顶上重新找。
  */
  scrollBehavior(to, from, savedPosition) {
    return savedPosition || { top: 0 }
  },
})

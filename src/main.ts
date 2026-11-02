import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.min.js'
import 'bootstrap-icons/font/bootstrap-icons.css'
import './assets/theme.css'

import App from './App.vue'
import router from './router'
import { installLongPressContextMenu } from './utils/longPressContextMenu'

const app = createApp(App)

app.use(createPinia())
app.use(router)

installLongPressContextMenu()

// Machine wallpaper images cached by older versions; safe to drop once browsers have updated.
indexedDB.deleteDatabase('deskconn-wallpaper')

router.isReady().then(() => app.mount('#app'))

import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { registerStdlib } from './components/stdlib'
import { installRegistry } from './core/registry'

registerStdlib()

const app = createApp(App)
installRegistry(app)
app.mount('#app')

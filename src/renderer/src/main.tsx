import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import TrayApp from './TrayApp'

document.documentElement.dataset.platform = window.api.platform
const surface = new URLSearchParams(window.location.search).get('surface')
document.documentElement.dataset.surface = surface === 'tray' ? 'tray' : 'app'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {surface === 'tray' ? <TrayApp /> : <App />}
  </StrictMode>
)

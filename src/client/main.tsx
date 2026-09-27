import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DetachedBrowserWindowApp from './components/browser/DetachedBrowserWindowApp'
import { isDetachedBrowserWindow } from './components/browser/renderer-mode'
import './index.css'
import './i18n'
import { initDesktopApi } from './lib/desktop-api'

initDesktopApi()

const RootApp = isDetachedBrowserWindow(window.location.search) ? DetachedBrowserWindowApp : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
)

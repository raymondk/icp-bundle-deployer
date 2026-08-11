import './style.css'
import { detectNetwork } from './app/network'
import { mountApp } from './app/ui'

mountApp(document.querySelector<HTMLDivElement>('#app')!, detectNetwork())

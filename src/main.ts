import './style.css'
import { detectNetwork } from './ic/network'
import { mountApp } from './ui/app'

mountApp(document.querySelector<HTMLDivElement>('#app')!, detectNetwork())

import './style.css'
import { detectNetwork } from './app/network'
import { mountApp } from './app/ui'

const root = document.querySelector<HTMLDivElement>('#app')!
try {
  mountApp(root, detectNetwork())
} catch (error) {
  // Nothing on the page works without knowing the network, so say why rather
  // than render a page whose every action would fail.
  root.innerHTML = `<section class="panel"><p class="error"></p></section>`
  root.querySelector('.error')!.textContent = error instanceof Error ? error.message : String(error)
}

/**
 * The deployer UI: pick a bundle, sign in, deploy.
 *
 * The DOM skeleton is built once and its regions are updated in place, so the file
 * input and drop target keep their identity across renders.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { loadBundle, type Bundle } from '../bundle'
import { deployBundle, formatBytes, type DeployEvent, type DeployResult } from '../deploy'
import { restoreSession, signInWithInternetIdentity, signOut, useTemporaryIdentity, type Session } from '../ic/auth'
import { createAgent, describeNetwork, type Network } from '../ic/network'
import { cyclesBalance, formatCycles } from '../ic/cycles-ledger'

interface State {
  network: Network
  session?: Session
  agent?: HttpAgent
  balance?: bigint
  bundle?: Bundle
  bundleError?: string
  busy: boolean
  result?: DeployResult
}

const SKELETON = `
  <header class="header">
    <h1>Bundle deployer</h1>
    <p class="subtitle">
      Deploy an application bundle to the Internet Computer — entirely from this page.
    </p>
  </header>

  <section class="panel" id="identity-panel"></section>

  <section class="panel">
    <div class="dropzone" id="dropzone" tabindex="0" role="button">
      <strong>Drop an application bundle here</strong>
      <span class="hint">or click to choose a <code>.icp</code> file</span>
      <input type="file" id="file-input" accept=".icp,.tar,.tar.gz,.tgz" hidden />
    </div>
    <div id="bundle-panel"></div>
  </section>

  <section class="panel">
    <button id="deploy" class="primary" disabled>Deploy</button>
    <ol class="log" id="log"></ol>
    <div id="result"></div>
  </section>
`

export function mountApp(root: HTMLElement, network: Network): void {
  root.innerHTML = SKELETON

  const state: State = { network, busy: false }

  const identityPanel = select<HTMLElement>(root, '#identity-panel')
  const bundlePanel = select<HTMLElement>(root, '#bundle-panel')
  const resultPanel = select<HTMLElement>(root, '#result')
  const dropzone = select<HTMLElement>(root, '#dropzone')
  const fileInput = select<HTMLInputElement>(root, '#file-input')
  const deployButton = select<HTMLButtonElement>(root, '#deploy')
  const log = select<HTMLOListElement>(root, '#log')

  function renderIdentity(): void {
    const { network, session, balance } = state
    const rows = [row('Network', escapeHtml(describeNetwork(network)))]

    if (session) {
      rows.push(
        row('Identity', `<code>${escapeHtml(session.principal.toText())}</code>`),
        row(
          'Signed in with',
          session.source === 'internet-identity' ? 'Internet Identity' : 'a temporary browser key',
        ),
      )
      if (network.kind === 'mainnet') {
        rows.push(row('Cycles', balance === undefined ? 'checking…' : escapeHtml(formatCycles(balance))))
      }
    }

    const actions = session
      ? `<button id="sign-out">Sign out</button>`
      : `<button id="sign-in" class="primary">Sign in with Internet Identity</button>` +
        (network.kind === 'mainnet'
          ? ''
          : `<button id="use-temporary">Use a temporary identity</button>`)

    identityPanel.innerHTML = `<dl class="facts">${rows.join('')}</dl><div class="actions">${actions}</div>`

    identityPanel.querySelector('#sign-in')?.addEventListener('click', () => {
      void withBusy(async () => establish(await signInWithInternetIdentity()))
    })
    identityPanel.querySelector('#use-temporary')?.addEventListener('click', () => {
      void withBusy(async () => establish(useTemporaryIdentity()))
    })
    identityPanel.querySelector('#sign-out')?.addEventListener('click', () => {
      void withBusy(async () => {
        await signOut()
        state.session = undefined
        state.agent = undefined
        state.balance = undefined
        renderIdentity()
        renderDeployButton()
      })
    })
  }

  async function establish(session: Session): Promise<void> {
    state.session = session
    state.agent = await createAgent(state.network, session.identity)
    state.balance = undefined
    renderIdentity()
    renderDeployButton()

    if (state.network.kind === 'mainnet') {
      // Informational only — a failure here must not block deploying.
      try {
        state.balance = await cyclesBalance(state.agent, session.principal)
      } catch {
        state.balance = 0n
      }
      renderIdentity()
    }
  }

  function renderBundle(): void {
    if (state.bundleError) {
      bundlePanel.innerHTML = `<p class="error">${escapeHtml(state.bundleError)}</p>`
      return
    }
    if (!state.bundle) {
      bundlePanel.innerHTML = ''
      return
    }

    const { fileName, manifest, digests } = state.bundle
    const rows = manifest.canisters
      .map(
        (canister) => `
        <tr>
          <td><strong>${escapeHtml(canister.name)}</strong></td>
          <td><code>${escapeHtml(canister.wasmPath)}</code></td>
          <td>${escapeHtml(formatBytes(canister.wasm.length))}</td>
          <td class="digest">${
            canister.sha256
              ? '<span class="ok">sha256 verified</span>'
              : `<span class="warn">no digest declared</span><br /><code>${escapeHtml(
                  digests.get(canister.name) ?? '',
                )}</code>`
          }</td>
        </tr>`,
      )
      .join('')

    bundlePanel.innerHTML = `
      <p class="loaded">Loaded <strong>${escapeHtml(fileName)}</strong> — ${
        manifest.canisters.length
      } canister${manifest.canisters.length === 1 ? '' : 's'}.</p>
      <table class="canisters">
        <thead><tr><th>Canister</th><th>Wasm</th><th>Size</th><th>Integrity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }

  function renderDeployButton(): void {
    deployButton.disabled = state.busy || !state.bundle || !state.agent
    deployButton.textContent = state.busy ? 'Working…' : 'Deploy'
  }

  function renderResult(): void {
    const { result, network } = state
    if (!result) {
      resultPanel.innerHTML = ''
      return
    }

    const sections: string[] = []
    if (result.deployed.length > 0) {
      sections.push(
        `<h2>Deployed</h2><ul class="deployed">${result.deployed
          .map(
            ({ name, canisterId }) =>
              `<li><strong>${escapeHtml(name)}</strong> <code>${escapeHtml(canisterId.toText())}</code>${
                network.kind === 'mainnet'
                  ? ` <a href="https://dashboard.internetcomputer.org/canister/${escapeHtml(
                      canisterId.toText(),
                    )}" target="_blank" rel="noreferrer">dashboard</a>`
                  : ''
              }</li>`,
          )
          .join('')}</ul>`,
      )
    }
    if (result.incomplete.length > 0) {
      sections.push(
        `<p class="warn">Created but not installed: ${result.incomplete
          .map(({ name, canisterId }) => `${escapeHtml(name)} (${escapeHtml(canisterId.toText())})`)
          .join(', ')}. They exist and are controlled by you.</p>`,
      )
    }
    if (result.error) {
      sections.push(`<p class="error">${escapeHtml(result.error)}</p>`)
    }
    resultPanel.innerHTML = sections.join('')
  }

  function appendLog(message: string, kind: 'info' | 'error' | 'done' = 'info'): void {
    const line = document.createElement('li')
    line.className = kind
    line.textContent = message
    log.append(line)
    line.scrollIntoView({ block: 'nearest' })
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    state.busy = true
    renderDeployButton()
    try {
      await action()
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      state.busy = false
      renderDeployButton()
    }
  }

  async function openBundle(file: File): Promise<void> {
    state.bundle = undefined
    state.bundleError = undefined
    state.result = undefined
    log.replaceChildren()
    renderResult()

    try {
      state.bundle = await loadBundle(file)
    } catch (error) {
      state.bundleError = error instanceof Error ? error.message : String(error)
    }
    renderBundle()
    renderDeployButton()
  }

  function onDeployEvent(event: DeployEvent): void {
    switch (event.type) {
      case 'started':
        appendLog(`${event.name}: creating canister…`)
        break
      case 'created':
        appendLog(`${event.name}: created ${event.canisterId.toText()}`)
        break
      case 'progress':
        appendLog(`${event.name}: ${event.message}`)
        break
      case 'installed':
        appendLog(`${event.name}: installed`, 'done')
        break
      case 'failed':
        appendLog(event.message, 'error')
        break
    }
  }

  dropzone.addEventListener('click', () => fileInput.click())
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      fileInput.click()
    }
  })
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropzone.classList.add('over')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'))
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropzone.classList.remove('over')
    const file = event.dataTransfer?.files?.[0]
    if (file) void openBundle(file)
  })
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void openBundle(file)
  })

  deployButton.addEventListener('click', () => {
    const { bundle, agent, network } = state
    if (!bundle || !agent) return
    void withBusy(async () => {
      log.replaceChildren()
      state.result = await deployBundle({ bundle, agent, network, onEvent: onDeployEvent })
      renderResult()
    })
  })

  renderIdentity()
  renderDeployButton()

  void restoreSession().then(async (session) => {
    if (session) await establish(session)
  })
}

function select<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element ${selector}`)
  return element
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}

function row(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
}

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const scriptPath = new URL('./dist/widget.js', import.meta.url)
const script = readFileSync(scriptPath, 'utf8')
const html = readFileSync(new URL('./src/card.html', import.meta.url), 'utf8')
writeFileSync(new URL('./dist/card.html', import.meta.url), html.replace('<!-- widget script -->', () => `<script>\n${script}</script>`))
unlinkSync(scriptPath)

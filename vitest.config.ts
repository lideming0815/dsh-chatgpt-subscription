/** Transform the shared UI primitives and their CSS in browser component tests. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: { deps: { inline: [/@deepseek-ai[+/]dsh-client-ui-primitives/, /packages\/client\/ui-primitives/] } },
  },
})

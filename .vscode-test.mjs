import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	extensions: [
		'vscodevim.vim',
		'vspacecode.whichkey',
		'jacobdufault.fuzzy-search'
	]
});

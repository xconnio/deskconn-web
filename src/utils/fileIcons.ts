/**
 * VS Code-style language icons for a file name, from Material Icon Theme
 * (material-icon-theme's icons/*.svg). Whole file names win over extensions,
 * the way VS Code icon themes resolve them.
 */

// Only the icons named below are bundled — keep this list in sync with the
// maps (an icon missing here falls back to the plain document icon).
import makefileIconUrl from '@/assets/icons/makefile.svg?url'
import goSumIconUrl from '@/assets/icons/go-sum.svg?url'
import goModIconUrl from '@/assets/icons/go-mod.svg?url'

const ICON_URLS = import.meta.glob(
  '/node_modules/material-icon-theme/icons/{assembly,astro,audio,bazel,bun,c,certificate,clojure,cmake,coffee,console,cpp,crystal,csharp,css,d,dart,database,diff,docker,document,editorconfig,elixir,elm,erlang,eslint,fortran,fsharp,gemfile,git,go_gopher,gradle,graphql,groovy,h,handlebars,haskell,hcl,heroku,hpp,html,http,image,java,javascript,jenkins,jinja,jsconfig,json,julia,jupyter,key,kotlin,less,license,lisp,lock,log,lua,markdown,matlab,mdx,nginx,nim,nix,nodejs,npm,objective-c,objective-cpp,ocaml,pascal,pdf,perl,php,pnpm,powershell,prettier,prisma,prolog,proto,pug,python,python-misc,r,racket,react,react_ts,readme,ruby,rust,sass,scala,settings,solidity,svelte,svg,swift,table,tcl,terraform,tex,toml,tsconfig,tune,twig,typescript,vagrant,verilog,video,vim,vue,xml,yaml,yarn,zig,zip}.svg',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>

// Our own icons, for files Material draws differently than GoLand does.
const CUSTOM_ICON_URLS: Record<string, string> = { makefile: makefileIconUrl, 'go-sum': goSumIconUrl, 'go-mod': goModIconUrl }

function iconUrl(name: string): string {
  return (
    CUSTOM_ICON_URLS[name] ??
    ICON_URLS[`/node_modules/material-icon-theme/icons/${name}.svg`] ??
    ICON_URLS['/node_modules/material-icon-theme/icons/document.svg']!
  )
}

// Lowercased whole file names.
const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  '.dockerignore': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  'package.json': 'nodejs',
  'package-lock.json': 'npm',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs',
  'yarn.lock': 'yarn',
  '.yarnrc': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'go.mod': 'go-mod',
  'go.sum': 'go-sum',
  'go.work': 'go-mod',
  'cargo.toml': 'rust',
  'cargo.lock': 'lock',
  'pubspec.yaml': 'dart',
  'pubspec.lock': 'lock',
  'requirements.txt': 'python-misc',
  'pyproject.toml': 'python-misc',
  'setup.py': 'python-misc',
  'setup.cfg': 'python-misc',
  'poetry.lock': 'lock',
  pipfile: 'python-misc',
  'pipfile.lock': 'lock',
  'uv.lock': 'lock',
  gemfile: 'gemfile',
  'gemfile.lock': 'gemfile',
  rakefile: 'ruby',
  'composer.json': 'php',
  'composer.lock': 'lock',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'jsconfig',
  jenkinsfile: 'jenkins',
  vagrantfile: 'vagrant',
  procfile: 'heroku',
  'nginx.conf': 'nginx',
  'build.gradle': 'gradle',
  'settings.gradle': 'gradle',
  'build.bazel': 'bazel',
  workspace: 'bazel',
  '.editorconfig': 'editorconfig',
  '.bashrc': 'console',
  '.bash_profile': 'console',
  '.zshrc': 'console',
  '.profile': 'console',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  copying: 'license',
}

const BY_EXT: Record<string, string> = {
  // Python
  py: 'python', pyi: 'python', pyw: 'python', ipynb: 'jupyter',
  // Systems
  go: 'go_gopher', rs: 'rust', zig: 'zig', nim: 'nim', d: 'd', cr: 'crystal',
  c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'hpp', hh: 'hpp', hxx: 'hpp',
  m: 'objective-c', mm: 'objective-cpp', swift: 'swift', cs: 'csharp',
  asm: 'assembly', s: 'assembly', f90: 'fortran', f: 'fortran', pas: 'pascal',
  sol: 'solidity', v: 'verilog', sv: 'verilog',
  // Web
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react_ts',
  vue: 'vue', svelte: 'svelte', astro: 'astro', dart: 'dart',
  html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  pug: 'pug', hbs: 'handlebars', handlebars: 'handlebars', twig: 'twig', j2: 'jinja', jinja: 'jinja',
  http: 'http', rest: 'http',
  // Docs & data
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', tex: 'tex',
  json: 'json', jsonc: 'json', json5: 'json', xml: 'xml', svg: 'svg',
  yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'settings', cfg: 'settings', conf: 'settings', properties: 'settings', env: 'tune',
  csv: 'table', tsv: 'table', xlsx: 'table',
  sql: 'database', db: 'database', sqlite: 'database', prisma: 'prisma',
  proto: 'proto', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff', lock: 'lock', log: 'log', txt: 'document',
  // Shells & build
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console', bat: 'console', cmd: 'console',
  ps1: 'powershell', psm1: 'powershell',
  mk: 'makefile', cmake: 'cmake', gradle: 'gradle', bzl: 'bazel', dockerfile: 'docker',
  tf: 'terraform', tfvars: 'terraform', hcl: 'hcl', nix: 'nix',
  // JVM, scripting & functional
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  clj: 'clojure', cljs: 'clojure', rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl',
  r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  ml: 'ocaml', fs: 'fsharp', elm: 'elm', vim: 'vim', coffee: 'coffee', lisp: 'lisp', el: 'lisp',
  rkt: 'racket', pro: 'prolog', mat: 'matlab', tcl: 'tcl',
  // Media, archives, keys
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  zip: 'zip', tar: 'zip', gz: 'zip', xz: 'zip', '7z': 'zip', rar: 'zip', bz2: 'zip',
  pem: 'certificate', crt: 'certificate', cer: 'certificate', key: 'key', pub: 'key',
}

function iconNameFor(name: string): string {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName
  // Dockerfile.dev, .env.local, README.md, .eslintrc.json… variants
  if (lower.startsWith('dockerfile') || lower.startsWith('containerfile')) return 'docker'
  if (lower === '.env' || lower.startsWith('.env.')) return 'tune'
  if (lower.startsWith('.eslintrc') || lower.startsWith('eslint.config.')) return 'eslint'
  if (lower.startsWith('.prettierrc') || lower.startsWith('prettier.config.')) return 'prettier'
  if (lower.startsWith('readme')) return 'readme'
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || 'document'
}

export function fileIconUrl(name: string): string {
  return iconUrl(iconNameFor(name))
}

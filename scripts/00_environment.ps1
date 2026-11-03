# Etapa 0 - Registro do ambiente de execucao (hardware, SO, navegador, versoes).
# Escreve results/environment.json
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController |
       Where-Object { $_.Name -notmatch "Parsec|Virtual" } | Select-Object -First 1
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"

$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$pyreq = @{}
Get-Content "$root\requirements.lock.txt" | ForEach-Object {
  if ($_ -match "^(.+?)==(.+)$") { $pyreq[$Matches[1]] = $Matches[2] }
}

$env_obj = [ordered]@{
  gerado_em = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
  hardware = [ordered]@{
    cpu            = $cpu.Name.Trim()
    cpu_nucleos    = $cpu.NumberOfCores
    cpu_threads    = $cpu.NumberOfLogicalProcessors
    cpu_clock_mhz  = $cpu.MaxClockSpeed
    ram_gb         = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    gpu            = $gpu.Name
    gpu_driver     = $gpu.DriverVersion
  }
  sistema = [ordered]@{
    so      = $os.Caption
    versao  = $os.Version
    build   = $os.BuildNumber
    arq     = $os.OSArchitecture
  }
  navegador = [ordered]@{
    nome   = "Google Chrome"
    versao = (Get-Item $chrome).VersionInfo.ProductVersion
    caminho = $chrome
    flags  = @("--disable-gpu-vsync", "--disable-frame-rate-limit",
               "--disable-background-timer-throttling",
               "--disable-backgrounding-occluded-windows",
               "--disable-renderer-backgrounding")
  }
  runtimes = [ordered]@{
    node   = (node --version)
    npm    = (npm --version)
    python = (& "$root\.venv\Scripts\python.exe" --version)
  }
  pacotes_node   = $pkg.dependencies
  pacotes_python = $pyreq
  bibliotecas_fixadas_na_cena = [ordered]@{
    aframe                 = "1.8.0 (vendor/aframe-v1.8.0.min.js)"
    physics_system         = "@c-frame/aframe-physics-system 4.2.4 (vendor/aframe-physics-system.js)"
    ammo                   = "MozillaReality/ammo.js@8bbc0ea builds/ammo.wasm.js + .wasm"
    observacao             = "todos servidos localmente; a cena nao depende de CDN"
  }
}

$env_obj | ConvertTo-Json -Depth 6 | Out-File "$root\results\environment.json" -Encoding utf8
Write-Output "escrito: results/environment.json"
Get-Content "$root\results\environment.json"

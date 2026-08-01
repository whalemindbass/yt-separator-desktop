# yss-engine 빌드 — 한글 경로 juceaide 크래시 회피 위해 ASCII 경로(C:\yss)로 복사 후 빌드
#   .\build.ps1                     # ASIO 없이
#   .\build.ps1 -AsioSdk C:\path\ASIOSDK\common   # ASIO 켜기
#   .\build.ps1 -Run stem1.wav stem2.wav          # 빌드 후 실행
param(
  [string]$AsioSdk = "C:\Users\wkq32\Downloads\ASIOSDK\common",
  [string[]]$Run,
  [string]$Work = "C:\yss"
)
# cmake 는 경고를 stderr 로 냄 → Stop 이면 경고에도 중단됨. Continue + exit-code 검사로 판단.
$ErrorActionPreference = "Continue"
$src = $PSScriptRoot

# 소스만 복사 (build/_deps 제외). robocopy exit<8 = 성공.
robocopy $src $Work /MIR /XD build _deps .git | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

$cfg = @("-S", $Work, "-B", "$Work\build")
if ($AsioSdk -and (Test-Path "$AsioSdk\asio.h")) {
  $cfg += @("-DYSS_ENABLE_ASIO=ON", "-DYSS_ASIO_SDK_DIR=$AsioSdk")
  Write-Host "ASIO: on ($AsioSdk)"
} else { Write-Host "ASIO: off" }

cmake @cfg
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }
cmake --build "$Work\build" --config Release
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }
$exe = "$Work\build\yss-engine_artefacts\Release\yss-engine.exe"
if (-not (Test-Path $exe)) { throw "exe not produced" }
Write-Host "built: $exe"

# 패키징용으로 repo engine/bin 에 복사 (electron-builder extraResources 대상)
$bin = Join-Path $src "bin"
New-Item $bin -ItemType Directory -Force | Out-Null
Copy-Item $exe $bin -Force
Write-Host "copied to: $bin\yss-engine.exe"
if ($PSBoundParameters.ContainsKey('Run')) { & $exe @Run }

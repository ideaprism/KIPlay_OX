# 12:55 — 공개 URL 만들기
#
# 배포 없이 이 PC의 서버를 인터넷에 노출한다. 직원들에게 링크를 보내 바로 테스트할 수 있다.
# 계정도 설치도 필요 없다. Windows에 기본 포함된 ssh만 쓴다.
#
#   실행:  powershell -ExecutionPolicy Bypass -File share.ps1
#   중지:  이 창에서 Ctrl+C  (또는 창을 닫는다)
#
# 주의
#   · 이 PC가 켜져 있고 이 창이 떠 있는 동안만 URL이 살아 있다. 절전 모드로 들어가면 끊긴다.
#   · URL은 껐다 켤 때마다 바뀐다.
#   · 운영자 콘솔 키는 매번 새로 만들어 이 창에 표시한다. 링크와 함께 뿌리지 말 것.
#   · 정기 회차에는 이 방식 대신 Render 같은 상시 호스팅에 올린다 (README 참조).

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$port = 12055

# ── 운영 키 생성 (공개 저장소의 기본값 kipi를 그대로 노출하지 않는다)
$chars = 'abcdefghjkmnpqrstuvwxyz23456789'
$key = -join ((1..10) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
$env:ADMIN_KEY = $key

# ── 이전 프로세스 정리
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*node.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# ── 게임 서버
Write-Host "`n게임 서버를 시작합니다..." -ForegroundColor DarkGray
$server = Start-Process node -ArgumentList 'server.js' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput '.tunnel-server.log' -RedirectStandardError '.tunnel-server.err'
Start-Sleep -Seconds 2

try { Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5 | Out-Null }
catch { Write-Host "서버가 뜨지 않았습니다. .tunnel-server.err 를 확인하세요." -ForegroundColor Red; exit 1 }

# ── 터널
Write-Host "공개 주소를 받는 중..." -ForegroundColor DarkGray
Remove-Item '.tunnel-lhr.log', '.tunnel-lhr.err' -ErrorAction SilentlyContinue
$ssh = Start-Process ssh -PassThru -WindowStyle Hidden `
  -ArgumentList '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30',
                '-R', "80:localhost:$port", 'nokey@localhost.run' `
  -RedirectStandardOutput '.tunnel-lhr.log' -RedirectStandardError '.tunnel-lhr.err'

$url = $null
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  $txt = (Get-Content '.tunnel-lhr.log' -Raw -ErrorAction SilentlyContinue) +
         (Get-Content '.tunnel-lhr.err' -Raw -ErrorAction SilentlyContinue)
  $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.lhr\.life')
  if ($m.Success) { $url = $m.Value; break }
}

if (-not $url) {
  Write-Host "공개 주소를 받지 못했습니다. 사내망이 SSH를 막고 있을 수 있습니다." -ForegroundColor Red
  Stop-Process -Id $server.Id, $ssh.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# ── 점검
Write-Host "연결을 점검하는 중..." -ForegroundColor DarkGray
node scripts/tunnel-check.js $url $key

$bar = '─' * 62
Write-Host "`n$bar" -ForegroundColor DarkGray
Write-Host "  직원들에게 보낼 주소" -ForegroundColor DarkGray
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ''
Write-Host "  전광판   $url/board.html" -ForegroundColor DarkGray
Write-Host "  운영자   $url/admin.html   키: $key" -ForegroundColor DarkGray
Write-Host "$bar" -ForegroundColor DarkGray
Write-Host "  이 창을 닫거나 Ctrl+C를 누르면 주소가 사라집니다." -ForegroundColor DarkGray
Write-Host "  PC가 절전 모드로 들어가도 끊깁니다.`n" -ForegroundColor DarkGray

try {
  while ($true) {
    Start-Sleep -Seconds 5
    if ($server.HasExited -or $ssh.HasExited) { Write-Host "연결이 끊겼습니다." -ForegroundColor Yellow; break }
  }
} finally {
  Stop-Process -Id $server.Id, $ssh.Id -Force -ErrorAction SilentlyContinue
  Write-Host "정리 완료.`n" -ForegroundColor DarkGray
}

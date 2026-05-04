param(
  [int[]]$Ports = @(4000, 10531)
)

$ErrorActionPreference = "Stop"

foreach ($port in $Ports) {
  $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    Stop-Process -Id $connection.OwningProcess -Force
    Write-Host "Stopped 127.0.0.1:$port (PID $($connection.OwningProcess))"
  }
}

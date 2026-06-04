Set-Location "D:\agent\AgentHub-Fullstack"
$env:DOTENV_CONFIG_PATH = "D:\agent\AgentHub-Fullstack\output\playwright\agenthub-ui\mock-empty.env"
$env:DOTENV_CONFIG_OVERRIDE = "true"
Get-Content "D:\agent\AgentHub-Fullstack\backend\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    $key = $matches[1].Trim()
    $value = $matches[2]
    if ($key -ne "DOWNSTREAM_ORCHESTRATOR_WS_URL") {
      Set-Item -Path "Env:$key" -Value $value
    }
  }
}
$env:DOWNSTREAM_ORCHESTRATOR_WS_URL = ""
pnpm --filter @agenthub/backend dev *> output/playwright/agenthub-ui/backend-mock.log

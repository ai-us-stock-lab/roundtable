param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$VoiceName = '',
  [ValidateRange(-10, 10)][int]$Rate = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled })
  if ($VoiceName) {
    $match = $voices | Where-Object { $_.VoiceInfo.Name -eq $VoiceName } | Select-Object -First 1
    if (-not $match) {
      $available = ($voices | ForEach-Object { $_.VoiceInfo.Name }) -join ', '
      throw "SAPI 声音 '$VoiceName' 未安装。可用声音: $available"
    }
    $speaker.SelectVoice($match.VoiceInfo.Name)
  } else {
    $zh = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
    if (-not $zh) {
      $available = ($voices | ForEach-Object { $_.VoiceInfo.Name }) -join ', '
      throw "未找到中文 SAPI 声音。请在 Windows 语言设置安装中文语音包。可用声音: $available"
    }
    $speaker.SelectVoice($zh.VoiceInfo.Name)
  }
  $speaker.Rate = $Rate
  $text = [System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8)
  $speaker.SetOutputToWaveFile($OutputPath)
  $speaker.Speak($text)
  $speaker.SetOutputToNull()
  Write-Output $speaker.Voice.Name
}
finally {
  $speaker.Dispose()
}

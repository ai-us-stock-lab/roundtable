' Start Roundtable server hidden (no console window). ASCII only.
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & dir & "\start-server.cmd""", 0, False

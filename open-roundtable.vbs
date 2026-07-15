' Roundtable desktop launcher: runs opener hidden (same folder)
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & dir & "\open-roundtable.cmd""", 0, False

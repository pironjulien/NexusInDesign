function Get-UxpTextHash {
    param([Parameter(Mandatory)][byte[]]$Bytes, [Parameter(Mandatory)][string]$Name)
    if ([IO.Path]::GetExtension($Name) -notin '.js', '.json', '.html', '.txt') {
        throw 'Normalisation réservée aux ressources texte UXP.'
    }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes).Replace("`r`n", "`n")
    if ($Name -ceq 'manifest.json' -and $text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
}
Export-ModuleMember -Function Get-UxpTextHash

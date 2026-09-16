# Invite a Signal Room user. Cognito emails a temporary password, then the user is
# added to the owner or guest group. Requires an AWS CLI profile for the account.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^ap-southeast-1_[A-Za-z0-9]+$')][string]$UserPoolId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')][string]$Email,
  [Parameter(Mandatory = $true)][ValidateSet('owner', 'guest')][string]$Group
)
$ErrorActionPreference = 'Stop'

aws cognito-idp admin-create-user --region ap-southeast-1 --user-pool-id $UserPoolId --username $Email `
  --user-attributes "Name=email,Value=$Email" "Name=email_verified,Value=true" --desired-delivery-mediums EMAIL | Out-Null
if ($LASTEXITCODE -ne 0) { throw "admin-create-user failed." }

aws cognito-idp admin-add-user-to-group --region ap-southeast-1 --user-pool-id $UserPoolId --username $Email --group-name $Group
if ($LASTEXITCODE -ne 0) { throw "admin-add-user-to-group failed." }

Write-Output "Invited $Email as $Group."

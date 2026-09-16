#!/usr/bin/env bash
# Invite a Signal Room user. Cognito emails a temporary password, then the user is
# added to the owner or guest group. Requires an AWS CLI profile for the account.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <user-pool-id> <email> <owner|guest>" >&2
  exit 2
fi

pool_id="$1"
email="$2"
group="$3"

[[ "$pool_id" =~ ^ap-southeast-1_[A-Za-z0-9]+$ ]] || { echo "Invalid user pool id." >&2; exit 2; }
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "Invalid email address." >&2; exit 2; }
[[ "$group" == "owner" || "$group" == "guest" ]] || { echo "Group must be owner or guest." >&2; exit 2; }

aws cognito-idp admin-create-user \
  --region ap-southeast-1 \
  --user-pool-id "$pool_id" \
  --username "$email" \
  --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL > /dev/null

aws cognito-idp admin-add-user-to-group \
  --region ap-southeast-1 \
  --user-pool-id "$pool_id" \
  --username "$email" \
  --group-name "$group"

echo "Invited $email as $group."

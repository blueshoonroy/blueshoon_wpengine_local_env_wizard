#!/bin/bash

if [[ ${REMOTE_DOMAIN:-} ]];
then
  # First we update REMOTE_DOMAIN in the partial
  partial=/mnt/ddev_config/nginx_full/partials/remote-assets.conf
  partial_tmp=/tmp/remote-assets.conf
  envsubst "\$REMOTE_DOMAIN" < "$partial" > "$partial_tmp"
  NGINX_REMOTE_ASSETS=$(cat $partial_tmp)
  export NGINX_REMOTE_ASSETS

  # Then we inject the partial into the nginx config
  config_template=/mnt/ddev_config/nginx_full/nginx-site.conf
  config=/etc/nginx/sites-enabled/nginx-site.conf
  envsubst "\$NGINX_REMOTE_ASSETS" < "$config_template" > "$config"
fi

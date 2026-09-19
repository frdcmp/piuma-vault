# nginx image for k3s: frontend dist + config template baked in.
# The compose setup bind-mounts both; pods can't, so they ship in the image.
FROM nginx:alpine
COPY frontend/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

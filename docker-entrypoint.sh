#!/bin/sh
set -eu

config_dir=/config
runtime_dir=/run/folderframe
default_config=/usr/share/folderframe/folderframe.config.json
persistent_config="$config_dir/folderframe.config.json"
runtime_config="$runtime_dir/folderframe.config.json"

mkdir -p "$config_dir" "$runtime_dir"

if [ ! -e "$persistent_config" ]; then
    cp "$default_config" "$persistent_config"
fi

if [ ! -f "$persistent_config" ]; then
    echo "FolderFrame configuration path is not a regular file: $persistent_config" >&2
    exit 1
fi

if ! jq empty "$persistent_config" >/dev/null 2>&1; then
    echo "FolderFrame configuration is not valid JSON: $persistent_config" >&2
    exit 1
fi

source_label=${FOLDERFRAME_SOURCE_LABEL:-}
starting_view=${FOLDERFRAME_STARTING_VIEW:-}
default_sort=${FOLDERFRAME_DEFAULT_SORT:-}
slideshow_interval=${FOLDERFRAME_SLIDESHOW_INTERVAL:-}
image_mode=${FOLDERFRAME_IMAGE_MODE:-}
autoplay=${FOLDERFRAME_AUTOPLAY:-}
shuffle=${FOLDERFRAME_SHUFFLE:-}
gallery_refresh_interval=${FOLDERFRAME_GALLERY_REFRESH_INTERVAL:-}
embed_refresh_interval=${FOLDERFRAME_EMBED_REFRESH_INTERVAL:-}
remember_preferences=${FOLDERFRAME_REMEMBER_PREFERENCES:-}

validate_choice() {
    setting_name=$1
    setting_value=$2
    shift 2
    [ -z "$setting_value" ] && return 0
    for allowed_value in "$@"; do
        [ "$setting_value" = "$allowed_value" ] && return 0
    done
    echo "Invalid $setting_name value: $setting_value" >&2
    exit 1
}

if [ -n "$source_label" ] && ! printf '%s' "$source_label" | grep -q '[^[:space:]]'; then
    echo "FOLDERFRAME_SOURCE_LABEL must contain a visible character" >&2
    exit 1
fi

validate_choice FOLDERFRAME_STARTING_VIEW "$starting_view" folders all
validate_choice FOLDERFRAME_DEFAULT_SORT "$default_sort" filename newest oldest
validate_choice FOLDERFRAME_SLIDESHOW_INTERVAL "$slideshow_interval" 3 5 10 15 30 60 300 900 3600
validate_choice FOLDERFRAME_IMAGE_MODE "$image_mode" fit original
validate_choice FOLDERFRAME_AUTOPLAY "$autoplay" true false
validate_choice FOLDERFRAME_SHUFFLE "$shuffle" true false
validate_choice FOLDERFRAME_REMEMBER_PREFERENCES "$remember_preferences" true false

for interval_setting in gallery embed; do
    if [ "$interval_setting" = gallery ]; then
        interval_value=$gallery_refresh_interval
        interval_name=FOLDERFRAME_GALLERY_REFRESH_INTERVAL
    else
        interval_value=$embed_refresh_interval
        interval_name=FOLDERFRAME_EMBED_REFRESH_INTERVAL
    fi
    if [ -n "$interval_value" ]; then
        case "$interval_value" in
            *[!0-9]*|'')
                echo "Invalid $interval_name value: $interval_value" >&2
                exit 1
                ;;
        esac
        if [ "$interval_value" -lt 1 ] || [ "$interval_value" -gt 86400 ]; then
            echo "$interval_name must be between 1 and 86400 seconds" >&2
            exit 1
        fi
    fi
done

temp_config="$runtime_config.tmp"
jq \
    --arg source_label "$source_label" \
    --arg starting_view "$starting_view" \
    --arg default_sort "$default_sort" \
    --arg slideshow_interval "$slideshow_interval" \
    --arg image_mode "$image_mode" \
    --arg autoplay "$autoplay" \
    --arg shuffle "$shuffle" \
    --arg gallery_refresh_interval "$gallery_refresh_interval" \
    --arg embed_refresh_interval "$embed_refresh_interval" \
    --arg remember_preferences "$remember_preferences" \
    '
    if $source_label != "" then
        if (.sources | type) == "array" and (.sources | length) > 0
        then .sources[0].label = $source_label
        else error("FOLDERFRAME_SOURCE_LABEL requires at least one configured source")
        end
    else . end
    | if $starting_view != "" then .defaults.view = $starting_view else . end
    | if $default_sort != "" then .defaults.sort = $default_sort else . end
    | if $slideshow_interval != "" then .defaults.interval = ($slideshow_interval | tonumber) else . end
    | if $image_mode != "" then .defaults.imageMode = $image_mode else . end
    | if $autoplay != "" then .defaults.autoplay = ($autoplay == "true") else . end
    | if $shuffle != "" then .defaults.shuffle = ($shuffle == "true") else . end
    | if $gallery_refresh_interval != "" then .index.refreshInterval = ($gallery_refresh_interval | tonumber) else . end
    | if $embed_refresh_interval != "" then .embed.refreshInterval = ($embed_refresh_interval | tonumber) else . end
    | if $remember_preferences != "" then .defaults.rememberPreferences = ($remember_preferences == "true") else . end
    ' "$persistent_config" > "$temp_config"

chmod 0644 "$persistent_config" "$temp_config"
mv "$temp_config" "$runtime_config"

exec "$@"

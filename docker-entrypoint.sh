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
thumbnail_generation=${FOLDERFRAME_THUMBNAILS:-true}
manifest_generation=${FOLDERFRAME_MANIFEST:-true}
thumbnail_path=${FOLDERFRAME_THUMBNAIL_PATH:-/config/thumbnails}
manifest_path=${FOLDERFRAME_MANIFEST_PATH:-/config/folderframe-data/library.json}

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
validate_choice FOLDERFRAME_THUMBNAILS "$thumbnail_generation" true false
validate_choice FOLDERFRAME_MANIFEST "$manifest_generation" true false

validate_integer_range() {
    setting_name=$1
    setting_value=$2
    minimum=$3
    maximum=$4
    case "$setting_value" in
        *[!0-9]*|'')
            echo "Invalid $setting_name value: $setting_value" >&2
            exit 1
            ;;
    esac
    if [ "$setting_value" -lt "$minimum" ] || [ "$setting_value" -gt "$maximum" ]; then
        echo "$setting_name must be between $minimum and $maximum" >&2
        exit 1
    fi
}

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

if [ "$thumbnail_generation" = true ] || [ "$manifest_generation" = true ]; then
    validate_integer_range FOLDERFRAME_THUMBNAIL_INTERVAL "${FOLDERFRAME_THUMBNAIL_INTERVAL:-3600}" 60 86400
fi
if [ "$thumbnail_generation" = true ]; then
    validate_integer_range FOLDERFRAME_THUMBNAIL_SIZE "${FOLDERFRAME_THUMBNAIL_SIZE:-480}" 64 4096
    validate_integer_range FOLDERFRAME_THUMBNAIL_QUALITY "${FOLDERFRAME_THUMBNAIL_QUALITY:-80}" 1 100
fi

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
    --arg thumbnail_generation "$thumbnail_generation" \
    --arg manifest_generation "$manifest_generation" \
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
    | if $thumbnail_generation == "true" then
        if (.sources | type) == "array" and (.sources | length) > 0
        then .sources |= map(
            if ((.path | type) == "string" and (.path | startswith("photos/")))
            then .thumbnailPath = ("thumbnails/" + (.path | ltrimstr("photos/")))
            else .
            end
        )
        else error("FOLDERFRAME_THUMBNAILS requires at least one configured source")
        end
      else
        .sources |= map(
            if ((.path | type) == "string" and (.path | startswith("photos/")))
            then del(.thumbnailPath)
            else .
            end
        )
      end
    | if $manifest_generation == "true" then
        if (.sources | type) == "array" and (.sources | length) > 0
        then .sources |= map(
            if ((.path | type) == "string" and (.path | startswith("photos/")))
            then .manifestPath = "folderframe-data/library.json"
            else .
            end
        )
        else error("FOLDERFRAME_MANIFEST requires at least one configured source")
        end
      else
        .sources |= map(
            if ((.path | type) == "string" and (.path | startswith("photos/")))
            then del(.manifestPath)
            else .
            end
        )
      end
    ' "$persistent_config" > "$temp_config"

chmod 0644 "$persistent_config" "$temp_config"
mv "$temp_config" "$runtime_config"

if [ "$thumbnail_generation" = true ] || [ "$manifest_generation" = true ]; then
    export FOLDERFRAME_THUMBNAIL_PATH="$thumbnail_path"
    export FOLDERFRAME_MANIFEST_PATH="$manifest_path"
    export FOLDERFRAME_MANIFEST_ROOT="${manifest_path%/*}"
    [ "$thumbnail_generation" = false ] || mkdir -p "$thumbnail_path"
    [ "$manifest_generation" = false ] || mkdir -p "$FOLDERFRAME_MANIFEST_ROOT"
    python3 /usr/share/folderframe/thumbnail_worker.py &
fi

exec "$@"

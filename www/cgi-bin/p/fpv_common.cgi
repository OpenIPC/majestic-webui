#!/usr/bin/haserl
<%
# fpv_common.cgi
#
# The YAML helpers wfb.cgi is written against, and its only includer.
#
# It used to carry a second, larger half: a form handler and three renderers
# (process_form, display_settings, display_presets, display_system_actions)
# with the preset machinery and the per-setting description table under them.
# None of it had a call site, in this file or in wfb.cgi, and three things
# said it had never had one -- process_form read ${FORM_action}, which haserl
# does not export; the markup emitted config-table/danger-zone/preset-container,
# classes that appear in no stylesheet in the tree; and the preset code called
# `yaml-cli --get/--set`, a spelling every live call site in the repo spells
# -g/-s. It was an earlier, pre-Bootstrap generation of the page, kept alive by
# nothing but the include. Git history has it.

# Debug logging function
log_debug() {
    if [ "${CONFIG_DEBUG:-0}" = "1" ]; then
        echo "[CONFIG-UTILS] $1" >> /tmp/config-utils.log
    fi
}

# Enable debug by setting CONFIG_DEBUG=1
CONFIG_DEBUG=${CONFIG_DEBUG:-0}

# Config file locations
WFB_YAML="/etc/wfb.yaml"
MAJESTIC_YAML="/etc/majestic.yaml"

# Ensure directory exists
ensure_directory() {
    local dir_path="$1"
    
    # Check if directory exists
    if [ ! -d "$dir_path" ]; then
        # Create directory if it doesn't exist
        mkdir -p "$dir_path"
        
        # Return success/failure
        if [ $? -eq 0 ]; then
            log_debug "Directory created: $dir_path"
            return 0
        else
            log_debug "Failed to create directory: $dir_path"
            return 1
        fi
    else
        # Directory already exists
        log_debug "Directory already exists: $dir_path"
        return 0
    fi
}

# Check if wifibroadcast cli exists
has_wifibroadcast_cli() {
    command -v wifibroadcast >/dev/null 2>&1
}

# Retrieve a value from a YAML file
yaml_get_value() {
    local file="$1"
    local key="$2"
    local item="$3"
    
    # Create file if it doesn't exist
    if [ ! -f "$file" ]; then
        ensure_directory "$(dirname "$file")"
        touch "$file"
        return 1
    fi
    
    if has_wifibroadcast_cli; then
        # Use wifibroadcast cli with dot notation
        log_debug "using **** get YAML value using wifibroadcast cli, key: $key, item: $item"
        wifibroadcast cli -g ".$key.$item" 2>/dev/null
    else
        # Fallback to basic implementation for basic YAML using grep/sed
        log_debug "yaml-cli not available, using fallback method"
        grep "^$key:" "$file" 2>/dev/null | sed 's/^[^:]*:[[:space:]]*//'
    fi
}

# Set a value in a YAML file
yaml_set_value() {
    local file="$1"
    local key="$2"
    local item="$3"
    local value="$4"
    
    # Create file if it doesn't exist
    if [ ! -f "$file" ]; then
        ensure_directory "$(dirname "$file")"
        touch "$file"
    fi
    
    if has_wifibroadcast_cli; then
        # Use yaml-cli to set value
        log_debug "***** Set YAML value using wifibroadcast: $key = $value"
        wifibroadcast cli -s ".$key.$item" "$value" 2>/dev/null
    else
        # Fallback to basic implementation
        log_debug "yaml-cli not available, using fallback method"
        
        # Check if key exists
        if grep -q "^$key:" "$file" 2>/dev/null; then
            # Update existing value
            sed -i "s|^$key:.*|$key: $value|" "$file"
        else
            # Add new key-value pair
            echo "$key: $value" >> "$file"
        fi
    fi
}

%>
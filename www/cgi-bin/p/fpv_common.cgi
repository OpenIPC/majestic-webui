#!/usr/bin/haserl
<%
# fpv_common.cgi
# Haserl CGI script for handling OpenIPC configuration
# Supports both YAML configuration and legacy conf files

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
WFB_CONF="/etc/wfb.conf"
TELEMETRY_CONF="/etc/telemetry.conf"
DATALINK_CONF="/etc/datalink.conf"
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

# Check if we're using the YAML or legacy configuration
is_using_yaml() {
    if [ -f "$WFB_YAML" ]; then
        log_debug "Using YAML configuration (wfb.yaml exists)"
        return 0  # True in shell
    else
        log_debug "Using legacy configuration (wfb.conf)"
        return 1  # False in shell
    fi
}

# Get config value - automatically determines source and handles both YAML and conf formats
get_config_value() {
    local key="$1"
    local default_value="$2"
    local value=""
    
    log_debug "Getting config value for key: $key"
    
    if is_using_yaml; then
        # Get from YAML
        value=$(yaml_get_value "$WFB_YAML" "$key")
    else
        # Try to get from legacy conf files
        case "$key" in
            # WFB settings
            unit|wlan|region|channel|frequency|txpower|driver_txpower_override|bandwidth|stbc|ldpc|mcs_index|stream|link_id|udp_port|rcv_buf|frame_type|fec_k|fec_n|pool_timeout|guard_interval)
                value=$(legacy_get_value "$WFB_CONF" "$key")
                ;;
                
            # Telemetry settings
            serial|baud|router|stream_rx|stream_tx|port_rx|port_tx|one_way|aggregate|channels|fps|ahi)
                value=$(legacy_get_value "$TELEMETRY_CONF" "$key")
                ;;
                
            # Datalink settings
            daemon|telemetry|tunnel|usb_modem|gs_ipaddr|gs_port|use_zt|zt_netid)
                value=$(legacy_get_value "$DATALINK_CONF" "$key")
                ;;
                
            # Majestic settings - these would normally come from majestic.yaml but covering legacy case
            bitrate|resolution|*)
                # Default case - try each file
                value=$(legacy_get_value "$WFB_CONF" "$key")
                
                if [ -z "$value" ]; then
                    value=$(legacy_get_value "$TELEMETRY_CONF" "$key")
                fi
                
                if [ -z "$value" ]; then
                    value=$(legacy_get_value "$DATALINK_CONF" "$key")
                fi
                ;;
        esac
    fi
    
    # Return the found value or default
    if [ -n "$value" ]; then
        echo "$value"
    else
        echo "$default_value"
    fi
}

# Set a configuration value for a given key
set_config_value() {
    local key="$1"
    local value="$2"
    
    log_debug "Setting config value for key: $key = $value"
    
    if is_using_yaml; then
        # Set in YAML
        yaml_set_value "$WFB_YAML" "$key" "$value"
    else
        # Set in legacy conf files
        case "$key" in
            # WFB settings
            unit|wlan|region|channel|frequency|txpower|driver_txpower_override|bandwidth|stbc|ldpc|mcs_index|stream|link_id|udp_port|rcv_buf|frame_type|fec_k|fec_n|pool_timeout|guard_interval)
                legacy_set_value "$WFB_CONF" "$key" "$value"
                ;;
                
            # Telemetry settings
            serial|baud|router|stream_rx|stream_tx|port_rx|port_tx|one_way|aggregate|channels|fps|ahi)
                legacy_set_value "$TELEMETRY_CONF" "$key" "$value"
                ;;
                
            # Datalink settings
            daemon|telemetry|tunnel|usb_modem|gs_ipaddr|gs_port|use_zt|zt_netid)
                legacy_set_value "$DATALINK_CONF" "$key" "$value"
                ;;
                
            # Majestic settings or unknown - add to WFB
            *)
                legacy_set_value "$WFB_CONF" "$key" "$value"
                ;;
        esac
    fi
}

# Check if yaml-cli exists
has_yaml_cli() {
    command -v yaml-cli >/dev/null 2>&1
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

# Read a value from legacy conf file (key=value format)
legacy_get_value() {
    local file="$1"
    local key="$2"
    
    [ -f "$file" ] || return 1
    
    # Handle comments and extract value
    grep "^[[:space:]]*$key=" "$file" 2>/dev/null | \
        grep -v "^#" | cut -d'=' -f2- | head -n 1
}

# Set a value in legacy conf file (key=value format)
legacy_set_value() {
    local file="$1"
    local key="$2"
    local value="$3"
    
    # Create file if it doesn't exist
    if [ ! -f "$file" ]; then
        ensure_directory "$(dirname "$file")"
        touch "$file"
    fi
    
    if grep -q "^[[:space:]]*$key=" "$file" 2>/dev/null; then
        # Update existing value
        sed -i "s|^[[:space:]]*$key=.*|$key=$value|" "$file"
    else
        # Add new key-value pair
        echo "$key=$value" >> "$file"
    fi
}

# Apply preset file
apply_preset_file() {
    local preset_file="$1"      # Source file from preset
    local target_file="$2"      # Destination system config
    local file_type="$3"        # yaml or conf
    
    log_debug "Applying preset file: $preset_file to $target_file (type: $file_type)"
    
    # Ensure target directory exists
    local target_dir=$(dirname "$target_file")
    ensure_directory "$target_dir"
    
    # If target file doesn't exist, just copy it
    if [ ! -f "$target_file" ]; then
        cp "$preset_file" "$target_file"
        return $?
    fi
    
    # Apply based on file type
    case "$file_type" in
        yaml)
            # For YAML files
            if has_yaml_cli; then
                log_debug "Using yaml-cli to merge preset YAML"
                
                # We need to process the yaml file key by key using yaml-cli
                # First get all top-level keys from the preset file
                tmp_keys=$(mktemp)
                grep -E '^[a-zA-Z0-9_-]+:' "$preset_file" | sed 's/:.*//' > "$tmp_keys"
                
                # Apply each key
                while read -r key; do
                    value=$(yaml-cli --get "$key" --input "$preset_file" 2>/dev/null)
                    if [ -n "$value" ]; then
                        yaml-cli --set "$key=$value" --input "$target_file" --output "$target_file" 2>/dev/null
                        log_debug "Applied setting $key=$value from preset to target YAML"
                    fi
                done < "$tmp_keys"
                
                rm -f "$tmp_keys"
            else
                log_debug "yaml-cli not available, using basic method to merge YAML"
                # Simple line-by-line processing for basic YAML
                while IFS=': ' read -r key value; do
                    # Skip empty lines and comments
                    [ -z "$key" ] || [ "${key:0:1}" = "#" ] && continue
                    # Skip lines without a value or section headers
                    [ -z "$value" ] && continue
                    
                    # Clean up key/value
                    key=$(echo "$key" | tr -d ' ')
                    
                    # Set the value
                    yaml_set_value "$target_file" "$key" "$value"
                done < "$preset_file"
            fi
            ;;
            
        conf)
            # For conf files, apply line by line
            while IFS='=' read -r key value; do
                # Skip empty lines and comments
                [ -z "$key" ] || [ "${key:0:1}" = "#" ] && continue
                
                # Clean up key
                key=$(echo "$key" | tr -d ' ')
                
                # Set the value
                legacy_set_value "$target_file" "$key" "$value"
            done < "$preset_file"
            ;;
            
        *)
            log_debug "Unknown file type: $file_type"
            return 1
            ;;
    esac
    
    return 0
}

# Apply entire preset (handles multiple files)
apply_preset() {
    local preset_dir="$1"  # Directory containing preset files
    
    log_debug "Applying preset from directory: $preset_dir"
    
    # Check if using YAML or legacy config and apply appropriate files
    if is_using_yaml; then
        # Apply YAML configs
        [ -f "$preset_dir/wfb.yaml" ] && apply_preset_file "$preset_dir/wfb.yaml" "$WFB_YAML" "yaml"
        [ -f "$preset_dir/majestic.yaml" ] && apply_preset_file "$preset_dir/majestic.yaml" "$MAJESTIC_YAML" "yaml"
        
        # If the preset only has legacy files but we're in YAML mode,
        # we need to apply the legacy files to maintain preset functionality
        if [ ! -f "$preset_dir/wfb.yaml" ] && [ -f "$preset_dir/wfb.conf" ]; then
            log_debug "Preset contains only legacy files but system uses YAML format"
            
            # Create a temporary YAML file to hold the converted settings
            tmp_yaml="/tmp/wfb_preset_temp.yaml"
            > "$tmp_yaml"
            
            # Process legacy config files and extract settings to temp YAML
            for conf_file in "$preset_dir/wfb.conf" "$preset_dir/telemetry.conf" "$preset_dir/datalink.conf"; do
                if [ -f "$conf_file" ]; then
                    log_debug "Processing legacy file for YAML mode: $conf_file"
                    while IFS='=' read -r key value; do
                        # Skip empty lines and comments
                        [ -z "$key" ] || [ "${key:0:1}" = "#" ] && continue
                        # Clean up key
                        key=$(echo "$key" | tr -d ' ')
                        # Add to temp YAML
                        yaml_set_value "$tmp_yaml" "$key" "$value"
                    done < "$conf_file"
                fi
            done
            
            # Apply the temp YAML to the real YAML config
            apply_preset_file "$tmp_yaml" "$WFB_YAML" "yaml"
            rm -f "$tmp_yaml"
        fi
    else
        # Apply legacy configs
        [ -f "$preset_dir/wfb.conf" ] && apply_preset_file "$preset_dir/wfb.conf" "$WFB_CONF" "conf"
        [ -f "$preset_dir/telemetry.conf" ] && apply_preset_file "$preset_dir/telemetry.conf" "$TELEMETRY_CONF" "conf"
        [ -f "$preset_dir/datalink.conf" ] && apply_preset_file "$preset_dir/datalink.conf" "$DATALINK_CONF" "conf"
    fi
    
    return 0
}

# Helper function to get list of supported values for a setting
get_allowed_values() {
    local setting="$1"
    
    case "$setting" in
        unit)
            echo "drone gs"
            ;;
        region)
            echo "00 US EU CN"
            ;;
        bandwidth)
            echo "20 40"
            ;;
        stbc|ldpc)
            echo "0 1"
            ;;
        guard_interval)
            echo "long short"
            ;;
        one_way)
            echo "true false"
            ;;
        *)
            echo ""
            ;;
    esac
}

# Get a human-readable description for a setting
get_setting_description() {
    local setting="$1"
    
    case "$setting" in
        unit)
            echo "Device role (drone or ground station)"
            ;;
        wlan)
            echo "WiFi interface name"
            ;;
        region)
            echo "WiFi regulatory domain (00=worldwide, US=United States, etc.)"
            ;;
        channel)
            echo "WiFi channel number"
            ;;
        frequency)
            echo "WiFi frequency in MHz (overrides channel if set)"
            ;;
        txpower)
            echo "WiFi transmission power level"
            ;;
        driver_txpower_override)
            echo "Override driver TX power settings"
            ;;
        bandwidth)
            echo "WiFi channel bandwidth in MHz"
            ;;
        stbc)
            echo "Space-Time Block Coding (improves range at expense of throughput)"
            ;;
        ldpc)
            echo "Low-Density Parity-Check coding (error correction)"
            ;;
        mcs_index)
            echo "Modulation and Coding Scheme index (higher=more speed, less range)"
            ;;
        stream)
            echo "Number of spatial streams"
            ;;
        link_id)
            echo "Unique link identifier to avoid interference"
            ;;
        udp_port)
            echo "UDP port for video stream"
            ;;
        rcv_buf)
            echo "UDP receive buffer size in bytes"
            ;;
        frame_type)
            echo "WiFi frame type (data or ieee80211)"
            ;;
        fec_k)
            echo "FEC parameter K (number of packets)"
            ;;
        fec_n)
            echo "FEC parameter N (total packets including redundant)"
            ;;
        pool_timeout)
            echo "Packet pool timeout in milliseconds"
            ;;
        guard_interval)
            echo "WiFi guard interval (long or short)"
            ;;
        serial)
            echo "Serial port for telemetry"
            ;;
        baud)
            echo "Serial baudrate"
            ;;
        router)
            echo "Telemetry router type (0=mavfwd, 1=mavlink-routerd, 2=msposd)"
            ;;
        stream_rx)
            echo "Telemetry receiving stream ID"
            ;;
        stream_tx)
            echo "Telemetry transmitting stream ID"
            ;;
        port_rx)
            echo "Telemetry receiving UDP port"
            ;;
        port_tx)
            echo "Telemetry transmitting UDP port"
            ;;
        one_way)
            echo "Enable one-way telemetry mode"
            ;;
        aggregate)
            echo "Telemetry packet aggregation level"
            ;;
        channels)
            echo "Number of RC channels to parse"
            ;;
        fps)
            echo "OSD frames per second"
            ;;
        ahi)
            echo "Artificial horizon indicator setting"
            ;;
        daemon)
            echo "Run as daemon"
            ;;
        telemetry)
            echo "Enable telemetry"
            ;;
        tunnel)
            echo "Enable IP tunnel"
            ;;
        usb_modem)
            echo "Use USB modem (LTE firmware only)"
            ;;
        gs_ipaddr)
            echo "Ground station IP address"
            ;;
        gs_port)
            echo "Ground station port"
            ;;
        use_zt)
            echo "Use ZeroTier (LTE/ultimate builds only)"
            ;;
        zt_netid)
            echo "ZeroTier network ID"
            ;;
        *)
            echo "$setting configuration"
            ;;
    esac
}

# Process form input
process_form() {
    if [ "${REQUEST_METHOD}" = "POST" ]; then
        # Handle form submission
        if [ -n "${FORM_action}" ]; then
            case "${FORM_action}" in
                save_config)
                    # Save configuration changes
                    for param in ${FORM_param_*}; do
                        key=$(echo "$param" | sed 's/FORM_param_//')
                        value=$(eval echo \$"$param")
                        set_config_value "$key" "$value"
                    done
                    result_message="Configuration saved successfully"
                    ;;
                    
                apply_preset)
                    # Apply a preset configuration
                    if [ -n "${FORM_preset_dir}" ]; then
                        apply_preset "${FORM_preset_dir}"
                        result_message="Preset applied successfully"
                    else
                        result_message="Error: No preset directory specified"
                    fi
                    ;;
                    
                reboot)
                    # Reboot the device
                    result_message="Device is rebooting..."
                    echo "<meta http-equiv=\"refresh\" content=\"3;url=/\">"
                    sync
                    reboot &
                    ;;
                    
                *)
                    result_message="Unknown action: ${FORM_action}"
                    ;;
            esac
        fi
    fi
}

# Display available settings
display_settings() {
    echo "<h2>Current Configuration</h2>"
    echo "<form method=\"post\">"
    echo "<input type=\"hidden\" name=\"action\" value=\"save_config\">"
    echo "<table class=\"config-table\">"
    echo "<tr><th>Setting</th><th>Value</th><th>Description</th></tr>"
    
    # Display common settings first
    for setting in unit wlan region channel frequency txpower bandwidth; do
        value=$(get_config_value "$setting" "")
        description=$(get_setting_description "$setting")
        allowed_values=$(get_allowed_values "$setting")
        
        echo "<tr>"
        echo "<td>$setting</td>"
        
        # If we have allowed values, show as dropdown
        if [ -n "$allowed_values" ]; then
            echo "<td><select name=\"param_$setting\">"
            for option in $allowed_values; do
                if [ "$option" = "$value" ]; then
                    echo "<option value=\"$option\" selected>$option</option>"
                else
                    echo "<option value=\"$option\">$option</option>"
                fi
            done
            echo "</select></td>"
        else
            echo "<td><input type=\"text\" name=\"param_$setting\" value=\"$value\"></td>"
        fi
        
        echo "<td>$description</td>"
        echo "</tr>"
    done
    
    # Advanced WFB settings
    echo "<tr class=\"section-header\"><td colspan=\"3\">Advanced WiFi Broadcast Settings</td></tr>"
    for setting in stbc ldpc mcs_index stream link_id udp_port rcv_buf frame_type fec_k fec_n pool_timeout guard_interval; do
        value=$(get_config_value "$setting" "")
        description=$(get_setting_description "$setting")
        allowed_values=$(get_allowed_values "$setting")
        
        echo "<tr>"
        echo "<td>$setting</td>"
        
        # If we have allowed values, show as dropdown
        if [ -n "$allowed_values" ]; then
            echo "<td><select name=\"param_$setting\">"
            for option in $allowed_values; do
                if [ "$option" = "$value" ]; then
                    echo "<option value=\"$option\" selected>$option</option>"
                else
                    echo "<option value=\"$option\">$option</option>"
                fi
            done
            echo "</select></td>"
        else
            echo "<td><input type=\"text\" name=\"param_$setting\" value=\"$value\"></td>"
        fi
        
        echo "<td>$description</td>"
        echo "</tr>"
    done
    
    # Telemetry settings
    echo "<tr class=\"section-header\"><td colspan=\"3\">Telemetry Settings</td></tr>"
    for setting in serial baud router stream_rx stream_tx port_rx port_tx one_way aggregate channels fps ahi; do
        value=$(get_config_value "$setting" "")
        description=$(get_setting_description "$setting")
        allowed_values=$(get_allowed_values "$setting")
        
        echo "<tr>"
        echo "<td>$setting</td>"
        
        # If we have allowed values, show as dropdown
        if [ -n "$allowed_values" ]; then
            echo "<td><select name=\"param_$setting\">"
            for option in $allowed_values; do
                if [ "$option" = "$value" ]; then
                    echo "<option value=\"$option\" selected>$option</option>"
                else
                    echo "<option value=\"$option\">$option</option>"
                fi
            done
            echo "</select></td>"
        else
            echo "<td><input type=\"text\" name=\"param_$setting\" value=\"$value\"></td>"
        fi
        
        echo "<td>$description</td>"
        echo "</tr>"
    done
    
    # Datalink settings
    echo "<tr class=\"section-header\"><td colspan=\"3\">Datalink Settings</td></tr>"
    for setting in daemon telemetry tunnel usb_modem gs_ipaddr gs_port use_zt zt_netid; do
        value=$(get_config_value "$setting" "")
        description=$(get_setting_description "$setting")
        allowed_values=$(get_allowed_values "$setting")
        
        echo "<tr>"
        echo "<td>$setting</td>"
        
        # If we have allowed values, show as dropdown
        if [ -n "$allowed_values" ]; then
            echo "<td><select name=\"param_$setting\">"
            for option in $allowed_values; do
                if [ "$option" = "$value" ]; then
                    echo "<option value=\"$option\" selected>$option</option>"
                else
                    echo "<option value=\"$option\">$option</option>"
                fi
            done
            echo "</select></td>"
        else
            echo "<td><input type=\"text\" name=\"param_$setting\" value=\"$value\"></td>"
        fi
        
        echo "<td>$description</td>"
        echo "</tr>"
    done
    
    echo "</table>"
    echo "<div class=\"button-group\">"
    echo "<input type=\"submit\" value=\"Save Configuration\">"
    echo "</div>"
    echo "</form>"
}

# Display presets section
display_presets() {
    echo "<h2>Configuration Presets</h2>"
    echo "<form method=\"post\">"
    echo "<input type=\"hidden\" name=\"action\" value=\"apply_preset\">"
    
    echo "<div class=\"preset-container\">"
    
    # Find all preset directories
    presets_dir="/etc/openipc/presets"
    if [ -d "$presets_dir" ]; then
        for preset in $(ls -1 "$presets_dir"); do
            if [ -d "$presets_dir/$preset" ]; then
                # Check if this preset has a description file
                preset_name="$preset"
                preset_desc=""
                if [ -f "$presets_dir/$preset/description.txt" ]; then
                    preset_desc=$(cat "$presets_dir/$preset/description.txt")
                fi
                
                echo "<div class=\"preset-item\">"
                echo "<input type=\"radio\" name=\"preset_dir\" value=\"$presets_dir/$preset\" id=\"preset_$preset\">"
                echo "<label for=\"preset_$preset\">$preset_name</label>"
                if [ -n "$preset_desc" ]; then
                    echo "<div class=\"preset-desc\">$preset_desc</div>"
                fi
                echo "</div>"
            fi
        done
        
        echo "<div class=\"button-group\">"
        echo "<input type=\"submit\" value=\"Apply Selected Preset\">"
        echo "</div>"
    else
        echo "<p>No presets available.</p>"
    fi
    
    echo "</div>"
    echo "</form>"
}

# System actions
display_system_actions() {
    echo "<h2>System Actions</h2>"
    echo "<form method=\"post\">"
    echo "<input type=\"hidden\" name=\"action\" value=\"reboot\">"
    echo "<div class=\"button-group danger-zone\">"
    echo "<input type=\"submit\" value=\"Reboot Device\" class=\"danger-button\">"
    echo "</div>"
    echo "</form>"
}

# Determine if using YAML or legacy format
config_format="Legacy configuration format"
if is_using_yaml; then
    config_format="YAML configuration format"
fi

check_password

%>
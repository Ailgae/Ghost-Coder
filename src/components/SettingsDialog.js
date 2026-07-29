import React, { useState } from 'react';

const SettingsDialog = ({ onClose }) => {
    const [isStreamingEnabled, setIsStreamingEnabled] = useState(false);

    const handleToggleChange = () => {
        setIsStreamingEnabled(!isStreamingEnabled);
        // Add logic to save the setting here
    };

    return (
        <div id="settings-dialog" className="dialog">
            <h2>Settings</h2>
            <label htmlFor="streaming-toggle">Enable Streaming:</label>
            <input type="checkbox" id="streaming-toggle" name="streaming-toggle" checked={isStreamingEnabled} onChange={handleToggleChange} />
            <button id="close-settings" onClick={onClose}>Close</button>
        </div>
    );
};

export default SettingsDialog;
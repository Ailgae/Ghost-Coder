import React, { useState } from 'react';
import SettingsDialog from './components/SettingsDialog';

const App = () => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const openSettings = () => {
        setIsSettingsOpen(true);
    };

    const closeSettings = () => {
        setIsSettingsOpen(false);
    };

    return (
        <div className="app">
            <button id="gear-button" onClick={openSettings}>⚙️</button>
            {isSettingsOpen && <SettingsDialog onClose={closeSettings} />}
        </div>
    );
};

export default App;
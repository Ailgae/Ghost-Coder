document.addEventListener('DOMContentLoaded', function() {
    const showDialog = () => {
        document.getElementById('confirmation-dialog').style.display = 'block';
    };

    const hideDialog = () => {
        document.getElementById('confirmation-dialog').style.display = 'none';
    };

    document.getElementById('decline').addEventListener('click', function() {
        console.log('User declined');
        hideDialog();
    });

    document.getElementById('allow').addEventListener('click', function() {
        console.log('User allowed');
        hideDialog();
    });

    document.getElementById('always-allow').addEventListener('click', function() {
        console.log('User always allowed');
        hideDialog();
    });

    // Example usage: Show dialog when a button is clicked
    document.getElementById('trigger-dialog').addEventListener('click', showDialog);
});
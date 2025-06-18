# Login Button Detection Feature

## Overview
The crawler now includes comprehensive login button detection and automatic login functionality with detailed event logging.

## Features Added

### 🔍 **Login Button Detection**
The crawler automatically scans for login buttons using these selectors:

#### Text-based Detection
- `button:has-text("Log in")`
- `button:has-text("Login")`
- `button:has-text("Sign in")`
- `button:has-text("Sign In")`
- `a:has-text("Login")` and variations

#### Class/ID-based Detection
- `button[class*="login"]`
- `button[id*="login"]`
- `a[class*="signin"]`
- And more variations

#### Data Attributes & Aria Labels
- `button[data-testid*="login"]`
- `button[aria-label*="login"]`
- `a[href*="login"]`

### 🎯 **Smart Login Flow**
1. **Button Detection**: Scans page for login buttons
2. **Button Click**: Clicks detected login button with human-like delays
3. **Form Detection**: Waits for login page to load, then scans for forms
4. **Credential Entry**: Fills username/email and password fields
5. **Form Submission**: Submits login form
6. **Success Verification**: Checks for login success indicators

### 📊 **Enhanced Form Detection**
Extended selectors for better form field detection:

#### Username/Email Fields
- `input[placeholder*="username"]`
- `input[placeholder*="email"]`
- `input[class*="username"]`
- `input[id*="email"]`

#### Password Fields
- `input[placeholder*="password"]`
- `input[class*="password"]`
- `input[id*="password"]`

#### Submit Buttons
- `button:has-text("Submit")`
- `button[class*="submit"]`
- `button[id*="login"]`

### 🎯 **Login Success Detection**
Automatically verifies login success by looking for:
- Logout buttons (`button:has-text("Logout")`)
- User menu elements (`[data-testid*="user-menu"]`)
- Dashboard elements (`[class*="dashboard"]`)
- Profile elements (`[class*="profile"]`)

### ❌ **Error Detection**
Detects login failures by scanning for:
- Error messages (`.error`, `[class*="error"]`)
- Alert boxes (`.alert-error`)
- Specific error text ("Invalid credentials", "Login failed")

## Event Logging

### 📝 **Comprehensive Event Tracking**
All login activities are logged with detailed information:

#### Login Button Events
```json
{
  "type": "login",
  "message": "Clicking login button: \"Sign In\"",
  "details": {
    "element_selector": "button:has-text(\"Sign In\")",
    "element_type": "button",
    "element_text": "Sign In"
  }
}
```

#### DOM Detection Events
```json
{
  "type": "dom_detection",
  "message": "Found username field: input[name=\"email\"]",
  "details": {
    "element_selector": "input[name=\"email\"]",
    "element_type": "input",
    "dom_elements_found": 1
  }
}
```

#### Success/Error Events
```json
{
  "type": "login",
  "message": "Login appears successful - found success indicator",
  "details": {
    "element_selector": "button:has-text(\"Logout\")"
  }
}
```

## Usage

### Configuration
Set login credentials in the crawler form:
```javascript
{
  loginCredentials: {
    username: "your-username",
    password: "your-password"
  }
}
```

### Automatic Operation
The login detection runs automatically on the first page (depth 0) when credentials are provided. The process includes:

1. Page loads
2. Login button detection begins
3. If found, button is clicked
4. Form detection starts
5. Credentials are entered with human-like typing
6. Form is submitted
7. Success/failure is verified
8. All actions are logged in real-time

### Event Log Visibility
All login activities appear in the Event Log panel with:
- Color-coded event types
- Detailed DOM element information
- Timestamp tracking
- Error details when issues occur

## Benefits

- **Automatic Login**: No manual intervention required
- **Comprehensive Detection**: Works with most login patterns
- **Human-like Behavior**: Includes delays and natural typing
- **Full Visibility**: Complete event logging for debugging
- **Error Handling**: Graceful failure with detailed error reporting
- **Success Verification**: Confirms login worked correctly
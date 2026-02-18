# SCORM Resume Capability Analyzer

A web-based tool to analyze SCORM packages and detect resume capability.

## Features

- 📦 Upload SCORM zip packages via drag-and-drop or file browser
- 🔍 Analyzes imsmanifest.xml for SCORM structure
- ✅ Detects resume capability indicators:
  - SCO (Sharable Content Object) resources
  - SCORM API calls (cmi.suspend_data, cmi.location, etc.)
  - Data persistence mechanisms
- 🎨 Modern, responsive UI with smooth animations
- 📊 Detailed analysis results

## Installation

1. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

3. Upload a SCORM package (zip file) and view the analysis results

## How It Works

The analyzer:
1. Extracts and parses the `imsmanifest.xml` file from the SCORM package
2. Checks for SCO resources (indicated by `adlcp:scormtype="sco"`)
3. Scans JavaScript files for SCORM API calls
4. Reports whether the package supports resume capability

## Resume Capability Indicators

A SCORM package is considered resume-capable if it contains:
- SCO resources (not just assets)
- SCORM API calls for data persistence (`cmi.suspend_data`, `cmi.location`, etc.)
- Proper manifest structure supporting learner progress tracking

## Dependencies

- **express**: Web server framework
- **multer**: File upload handling
- **adm-zip**: ZIP file extraction
- **xml2js**: XML parsing

## License

ISC

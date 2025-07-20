"""
SVG to GGTag Renderer
=====================

A Python renderer that converts SVG files to GGTag drawing commands.
Based on the GGTag class interface provided by the user.

Features:
- Converts SVG elements (text, rect, circle, line, basic paths) to GGTag commands
- Automatic coordinate scaling to fit GGTag dimensions (360x240 default)
- SVG namespace handling
- URL generation for ggtag.io
- Support for both file and string input

Usage:
    # Basic usage
    renderer = SVGToGGTagRenderer()
    ggtag = renderer.parse_svg_file('my_drawing.svg')
    print(ggtag)  # Print GGTag commands

    # Complete converter with URL generation
    converter = SVGToGGTagConverter()
    result = converter.convert_svg_file('my_drawing.svg')
    print("Commands:", result['commands'])
    print("URL:", result['url'])
"""

import xml.etree.ElementTree as ET
import re
import urllib.parse


class SVGToGGTagRenderer:
    """
    SVG to GGTag renderer that converts SVG elements to GGTag drawing commands.

    Supports:
    - Text elements
    - Rectangle elements  
    - Circle elements
    - Line elements
    - Path elements (basic line/move commands)
    """

    def __init__(self, ggtag_width=360, ggtag_height=240):
        """Initialize with GGTag dimensions"""
        self.ggtag_width = ggtag_width
        self.ggtag_height = ggtag_height
        self.svg_width = None
        self.svg_height = None
        self.scale_x = 1.0
        self.scale_y = 1.0

    def parse_svg_file(self, svg_file_path):
        """Parse SVG file and return GGTag object with converted elements"""
        tree = ET.parse(svg_file_path)
        return self._parse_svg_tree(tree)

    def parse_svg_string(self, svg_content):
        """Parse SVG string and return GGTag object with converted elements"""
        root = ET.fromstring(svg_content)
        tree = ET.ElementTree(root)
        return self._parse_svg_tree(tree)

    def _parse_svg_tree(self, tree):
        """Internal method to parse SVG tree and convert to GGTag"""

        # Mock GGTag class based on the user's provided interface
        class MockGGTag:
            def __init__(self, width=360, height=240):
                self._width = width
                self._height = height
                self._text_cmd = ""

            def _check_xy(self, x, y):
                if x < 0 or x >= self._width:
                    raise ValueError(f"x must be in range [0, {self._width})")
                if y < 0 or y >= self._height:
                    raise ValueError(f"y must be in range [0, {self._height})")

            def text(self, x, y, font_size, text):
                self._check_xy(x, y)
                self._text_cmd += f"\\t{x},{y},{font_size},{text}"

            def circle(self, x, y, radius):
                self._check_xy(x, y)
                self._text_cmd += f"\\c{x},{y},{radius}"

            def rect(self, x, y, width, height):
                self._check_xy(x, y)
                self._text_cmd += f"\\r{x},{y},{width},{height}"

            def line(self, x1, y1, x2, y2):
                self._check_xy(x1, y1)
                self._text_cmd += f"\\l{x1},{y1},{x2},{y2}"

            def qrcode(self, x, y, size, text):
                self._check_xy(x, y)
                self._text_cmd += f"\\q{x},{y},{size},{text}"

            def __str__(self):
                return self._text_cmd

        root = tree.getroot()
        ggtag = MockGGTag(self.ggtag_width, self.ggtag_height)

        # Get SVG dimensions and calculate scaling
        self._extract_svg_dimensions(root)
        self._calculate_scaling()

        # Parse all SVG elements
        self._parse_element(root, ggtag)

        return ggtag

    def _extract_svg_dimensions(self, root):
        """Extract SVG canvas dimensions"""
        # Get width and height attributes
        width_attr = root.get('width', '100')
        height_attr = root.get('height', '100')

        # Parse dimensions (handle units like px, pt, etc.)
        self.svg_width = self._parse_dimension(width_attr)
        self.svg_height = self._parse_dimension(height_attr)

        # Fallback to viewBox if no width/height
        if not self.svg_width or not self.svg_height:
            viewbox = root.get('viewBox')
            if viewbox:
                parts = viewbox.split()
                if len(parts) >= 4:
                    self.svg_width = float(parts[2])
                    self.svg_height = float(parts[3])

        # Default fallback
        if not self.svg_width:
            self.svg_width = 100
        if not self.svg_height:
            self.svg_height = 100

    def _parse_dimension(self, dim_str):
        """Parse dimension string (e.g., '100px', '50%', '100') to numeric value"""
        if not dim_str:
            return None

        # Remove units and extract numeric value
        match = re.match(r'([\d.]+)', dim_str.strip())
        if match:
            return float(match.group(1))
        return None

    def _calculate_scaling(self):
        """Calculate scaling factors to fit SVG into GGTag dimensions"""
        if self.svg_width and self.svg_height:
            self.scale_x = self.ggtag_width / self.svg_width
            self.scale_y = self.ggtag_height / self.svg_height

            # Use uniform scaling to maintain aspect ratio
            uniform_scale = min(self.scale_x, self.scale_y)
            self.scale_x = uniform_scale
            self.scale_y = uniform_scale

    def _scale_coordinate(self, x, y):
        """Scale SVG coordinates to GGTag coordinates"""
        scaled_x = int(x * self.scale_x)
        scaled_y = int(y * self.scale_y)

        # Clamp to GGTag bounds
        scaled_x = max(0, min(scaled_x, self.ggtag_width - 1))
        scaled_y = max(0, min(scaled_y, self.ggtag_height - 1))

        return scaled_x, scaled_y

    def _parse_element(self, element, ggtag):
        """Recursively parse SVG element and convert to GGTag commands"""
        # Handle namespace
        tag_name = element.tag
        if '}' in tag_name:
            tag_name = tag_name.split('}')[1]

        # Convert different SVG elements
        if tag_name == 'text':
            self._convert_text(element, ggtag)
        elif tag_name == 'rect':
            self._convert_rect(element, ggtag)
        elif tag_name == 'circle':
            self._convert_circle(element, ggtag)
        elif tag_name == 'line':
            self._convert_line(element, ggtag)
        elif tag_name == 'path':
            self._convert_path(element, ggtag)
        elif tag_name in ['g', 'svg']:
            # Recursively process group and svg children
            for child in element:
                self._parse_element(child, ggtag)

    def _convert_text(self, element, ggtag):
        """Convert SVG text element to GGTag text command"""
        x = float(element.get('x', 0))
        y = float(element.get('y', 0))

        # Extract font size (default to reasonable size for GGTag)
        font_size_attr = element.get('font-size', '12')
        font_size = self._parse_dimension(font_size_attr) or 12

        # Scale font size
        scaled_font_size = max(1, int(font_size * min(self.scale_x, self.scale_y)))

        # Get text content
        text_content = element.text or ''

        # Scale coordinates
        scaled_x, scaled_y = self._scale_coordinate(x, y)

        try:
            ggtag.text(scaled_x, scaled_y, scaled_font_size, text_content)
        except ValueError:
            # Skip if coordinates are out of bounds
            pass

    def _convert_rect(self, element, ggtag):
        """Convert SVG rect element to GGTag rect command"""
        x = float(element.get('x', 0))
        y = float(element.get('y', 0))
        width = float(element.get('width', 10))
        height = float(element.get('height', 10))

        # Scale dimensions
        scaled_x, scaled_y = self._scale_coordinate(x, y)
        scaled_width = max(1, int(width * self.scale_x))
        scaled_height = max(1, int(height * self.scale_y))

        try:
            ggtag.rect(scaled_x, scaled_y, scaled_width, scaled_height)
        except ValueError:
            pass

    def _convert_circle(self, element, ggtag):
        """Convert SVG circle element to GGTag circle command"""
        cx = float(element.get('cx', 0))
        cy = float(element.get('cy', 0))
        r = float(element.get('r', 5))

        # Scale dimensions
        scaled_cx, scaled_cy = self._scale_coordinate(cx, cy)
        scaled_r = max(1, int(r * min(self.scale_x, self.scale_y)))

        try:
            ggtag.circle(scaled_cx, scaled_cy, scaled_r)
        except ValueError:
            pass

    def _convert_line(self, element, ggtag):
        """Convert SVG line element to GGTag line command"""
        x1 = float(element.get('x1', 0))
        y1 = float(element.get('y1', 0))
        x2 = float(element.get('x2', 10))
        y2 = float(element.get('y2', 10))

        # Scale coordinates
        scaled_x1, scaled_y1 = self._scale_coordinate(x1, y1)
        scaled_x2, scaled_y2 = self._scale_coordinate(x2, y2)

        try:
            ggtag.line(scaled_x1, scaled_y1, scaled_x2, scaled_y2)
        except ValueError:
            pass

    #TODO: TO be useful, this will need to turtle around
    def _convert_path(self, element, ggtag):
        """Convert SVG path element to GGTag commands (basic support)"""
        d = element.get('d', '')
        if not d:
            return

        # Basic path command parsing (M, L, Z)
        commands = re.findall(r'[MLZ][^MLZ]*', d.strip())

        current_x, current_y = 0, 0
        path_start_x, path_start_y = 0, 0

        for cmd in commands:
            cmd = cmd.strip()
            if not cmd:
                continue

            cmd_type = cmd[0]
            coords_str = cmd[1:].strip()

            if cmd_type == 'M':  # Move to
                coords = self._parse_coordinates(coords_str)
                if coords:
                    current_x, current_y = coords[0]
                    path_start_x, path_start_y = current_x, current_y

            elif cmd_type == 'L':  # Line to
                coords = self._parse_coordinates(coords_str)
                for x, y in coords:
                    scaled_x1, scaled_y1 = self._scale_coordinate(current_x, current_y)
                    scaled_x2, scaled_y2 = self._scale_coordinate(x, y)

                    try:
                        ggtag.line(scaled_x1, scaled_y1, scaled_x2, scaled_y2)
                    except ValueError:
                        pass

                    current_x, current_y = x, y

            elif cmd_type == 'Z':  # Close path
                if current_x != path_start_x or current_y != path_start_y:
                    scaled_x1, scaled_y1 = self._scale_coordinate(current_x, current_y)
                    scaled_x2, scaled_y2 = self._scale_coordinate(path_start_x, path_start_y)

                    try:
                        ggtag.line(scaled_x1, scaled_y1, scaled_x2, scaled_y2)
                    except ValueError:
                        pass

    def _parse_coordinates(self, coords_str):
        """Parse coordinate string into list of (x, y) tuples"""
        coords = []
        # Match floating point numbers (positive/negative)
        numbers = re.findall(r'-?[\d.]+', coords_str)

        # Group into pairs
        for i in range(0, len(numbers), 2):
            if i + 1 < len(numbers):
                x = float(numbers[i])
                y = float(numbers[i + 1])
                coords.append((x, y))

        return coords


def create_ggtag_url(ggtag_commands, host='https://ggtag.io'):
    """Generate a ggtag.io URL from GGTag commands"""
    url = f"{host}/?i={urllib.parse.quote(ggtag_commands, safe='')}"
    return url


class SVGToGGTagConverter:
    """
    Complete SVG to GGTag converter with URL generation support
    """

    def __init__(self, ggtag_width=360, ggtag_height=240):
        self.renderer = SVGToGGTagRenderer(ggtag_width, ggtag_height)

    def convert_svg_file(self, svg_file_path):
        """Convert SVG file to GGTag and return commands + URL"""
        ggtag = self.renderer.parse_svg_file(svg_file_path)
        commands = str(ggtag)
        url = create_ggtag_url(commands)
        return {
            'commands': commands,
            'url': url,
            'svg_dimensions': (self.renderer.svg_width, self.renderer.svg_height),
            'ggtag_dimensions': (self.renderer.ggtag_width, self.renderer.ggtag_height),
            'scaling': (self.renderer.scale_x, self.renderer.scale_y)
        }

    def convert_svg_string(self, svg_content):
        """Convert SVG string to GGTag and return commands + URL"""
        ggtag = self.renderer.parse_svg_string(svg_content)
        commands = str(ggtag)
        url = create_ggtag_url(commands)
        return {
            'commands': commands,
            'url': url,
            'svg_dimensions': (self.renderer.svg_width, self.renderer.svg_height),
            'ggtag_dimensions': (self.renderer.ggtag_width, self.renderer.ggtag_height),
            'scaling': (self.renderer.scale_x, self.renderer.scale_y)
        }


# Example usage
if __name__ == "__main__":
    # Create SC2-themed SVG
    with open("./adafruit.svg","r") as fp:
        sc2_svg = fp.read()
        fp.close()


    # Convert and display
    converter = SVGToGGTagConverter()
    result = converter.convert_svg_string(sc2_svg)

    print("GGTag Commands:")
    print(result['commands'])
    print("\nGGTag.io URL:")
    print(result['url'])

#!/usr/bin/env python3
"""Local VTK viewport paired with the installed full ParaView workbench."""

from __future__ import annotations

import argparse
from pathlib import Path

from trame.app import get_server
from trame.decorators import change
from trame.ui.vuetify3 import SinglePageLayout
from trame.widgets import html, vtk as vtk_widgets, vuetify3
from vtkmodules.vtkIOGeometry import vtkOBJReader, vtkSTLReader
from vtkmodules.vtkIOLegacy import vtkDataSetReader
from vtkmodules.vtkIOXML import vtkXMLPolyDataReader, vtkXMLUnstructuredGridReader
from vtkmodules.vtkRenderingAnnotation import vtkScalarBarActor
from vtkmodules.vtkRenderingCore import vtkActor, vtkColorTransferFunction, vtkDataSetMapper, vtkRenderer, vtkRenderWindow
import vtkmodules.vtkInteractionStyle  # noqa: F401
import vtkmodules.vtkRenderingOpenGL2  # noqa: F401


def reader_for(path: Path):
    factory = {
        ".vtp": vtkXMLPolyDataReader,
        ".vtu": vtkXMLUnstructuredGridReader,
        ".vtk": vtkDataSetReader,
        ".stl": vtkSTLReader,
        ".obj": vtkOBJReader,
    }.get(path.suffix.lower())
    if not factory:
        raise RuntimeError(f"Embedded view does not support {path.suffix or 'this file type'}; use Full ParaView.")
    reader = factory()
    reader.SetFileName(str(path))
    reader.Update()
    return reader


class PiCadParaView:
    def __init__(self, source: Path, port: int) -> None:
        self.source = source
        self.port = port
        self.server = get_server(client_type="vue3")
        self.state = self.server.state
        self.ctrl = self.server.controller
        self.reader = reader_for(source)
        self.data = self.reader.GetOutputDataObject(0)
        self.mapper = vtkDataSetMapper()
        self.mapper.SetInputConnection(self.reader.GetOutputPort())
        self.actor = vtkActor()
        self.actor.SetMapper(self.mapper)
        self.actor.GetProperty().SetColor(0.67, 0.72, 0.78)
        self.actor.GetProperty().SetEdgeColor(0.16, 0.18, 0.21)
        self.actor.GetProperty().EdgeVisibilityOn()
        self.renderer = vtkRenderer()
        self.renderer.SetBackground(0.035, 0.039, 0.043)
        self.renderer.AddActor(self.actor)
        self.window = vtkRenderWindow()
        self.window.AddRenderer(self.renderer)
        self.window.SetOffScreenRendering(1)
        self.scalar_bar = vtkScalarBarActor()
        self.scalar_bar.SetNumberOfLabels(5)
        self.scalar_bar.SetMaximumWidthInPixels(90)
        self.scalar_bar.SetMaximumHeightInPixels(420)
        for text_property in (
            self.scalar_bar.GetTitleTextProperty(),
            self.scalar_bar.GetLabelTextProperty(),
        ):
            text_property.BoldOff()
            text_property.ItalicOff()
            text_property.SetColor(0.72, 0.75, 0.79)
            text_property.SetFontFamilyToArial()
        self.renderer.AddActor2D(self.scalar_bar)
        self._fields = self._available_fields()
        self.state.field_items = [{"title": "Solid color", "value": "Solid color"}, *[
            {"title": name, "value": f"{association}:{name}"} for name, association in self._fields
        ]]
        self.state.active_field = f"{self._fields[0][1]}:{self._fields[0][0]}" if self._fields else "Solid color"
        self.state.representation = "Surface with edges"
        self.state.source_name = source.name
        self._apply_field(self.state.active_field)
        self.renderer.ResetCamera()
        self.window.Render()
        self._build_ui()

    def _available_fields(self) -> list[tuple[str, str]]:
        fields: list[tuple[str, str]] = []
        for association, attributes in (("point", self.data.GetPointData()), ("cell", self.data.GetCellData())):
            for index in range(attributes.GetNumberOfArrays()):
                array = attributes.GetArray(index)
                if array and array.GetName() and array.GetNumberOfComponents() in (1, 3):
                    fields.append((array.GetName(), association))
        return fields

    def _apply_field(self, value: str) -> None:
        if value == "Solid color":
            self.mapper.ScalarVisibilityOff()
            self.scalar_bar.SetVisibility(False)
            return
        association, name = value.split(":", 1)
        attributes = self.data.GetPointData() if association == "point" else self.data.GetCellData()
        array = attributes.GetArray(name)
        if not array:
            return
        value_range = array.GetRange(-1 if array.GetNumberOfComponents() > 1 else 0)
        colors = vtkColorTransferFunction()
        colors.SetColorSpaceToDiverging()
        colors.AddRGBPoint(value_range[0], 0.231, 0.298, 0.753)
        colors.AddRGBPoint((value_range[0] + value_range[1]) / 2, 0.865, 0.865, 0.865)
        colors.AddRGBPoint(value_range[1], 0.706, 0.016, 0.149)
        self.mapper.SetLookupTable(colors)
        self.mapper.SetScalarRange(*value_range)
        self.mapper.SelectColorArray(name)
        if association == "point":
            self.mapper.SetScalarModeToUsePointFieldData()
        else:
            self.mapper.SetScalarModeToUseCellFieldData()
        self.mapper.ScalarVisibilityOn()
        self.scalar_bar.SetLookupTable(colors)
        self.scalar_bar.SetTitle(name)
        self.scalar_bar.SetVisibility(True)

    @change("active_field")
    def field_changed(self, active_field: str, **_kwargs) -> None:
        self._apply_field(active_field)
        self.ctrl.view_update()

    @change("representation")
    def representation_changed(self, representation: str, **_kwargs) -> None:
        prop = self.actor.GetProperty()
        if representation == "Wireframe":
            prop.SetRepresentationToWireframe()
        elif representation == "Points":
            prop.SetRepresentationToPoints()
        else:
            prop.SetRepresentationToSurface()
        prop.SetEdgeVisibility(representation == "Surface with edges")
        self.ctrl.view_update()

    def reset_camera(self) -> None:
        self.renderer.ResetCamera()
        self.ctrl.view_update()

    def _build_ui(self) -> None:
        with SinglePageLayout(
            self.server,
            full_height=True,
            theme="dark",
            vuetify_config={"theme": {"defaultTheme": "dark"}},
        ) as layout:
            layout.icon.hide()
            layout.footer.hide()
            layout.title.set_text("{{ source_name }}")
            layout.toolbar.dense = True
            layout.toolbar.color = "#0c0e10"
            layout.toolbar.height = 42
            layout.toolbar.elevation = 0
            with layout.root:
                html.Style("""
                    html, body, #app, .v-application { background: #090a0b !important; }
                    .v-app-bar { height: 42px !important; background: #0c0e10 !important;
                      color: #d9dde3 !important; border-bottom: 1px solid #262a30 !important;
                      box-shadow: none !important; }
                    .v-toolbar__content { height: 42px !important; padding: 0 10px !important; gap: 8px; }
                    .v-toolbar-title { font: 500 12px/1.2 Inter, ui-sans-serif, sans-serif !important; }
                    .v-app-bar-nav-icon { display: none !important; }
                    .v-field { font-size: 11px !important; color: #d9dde3 !important;
                      background: #111419 !important; border-radius: 7px !important; }
                    .v-field__outline { color: #343941 !important; }
                    .v-btn { color: #cbd0d8 !important; font-size: 11px !important;
                      text-transform: none !important; letter-spacing: 0 !important; }
                    .v-main { padding-top: 42px !important; }
                """)
            with layout.toolbar:
                vuetify3.VSpacer()
                vuetify3.VSelect(v_model=("active_field", "Solid color"), items=("field_items", []), density="compact", hide_details=True, variant="outlined", style="max-width:220px")
                vuetify3.VSelect(v_model=("representation", "Surface with edges"), items=("['Surface', 'Surface with edges', 'Wireframe', 'Points']",), density="compact", hide_details=True, variant="outlined", style="max-width:190px")
                vuetify3.VBtn("Reset", click=self.reset_camera, variant="text", size="small")
            with layout.content:
                with html.Div(style="height:100%;background:#090a0b"):
                    view = vtk_widgets.VtkRemoteLocalView(self.window, interactive_ratio=1)
                    self.ctrl.view_update = view.update
                    self.ctrl.view_reset_camera = view.reset_camera

    def start(self) -> None:
        self.server.start(host="127.0.0.1", port=self.port, open_browser=False, show_connection_info=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    PiCadParaView(args.source.resolve(strict=True), args.port).start()


if __name__ == "__main__":
    main()

# Pi-CAD gap closure

Current state: GAP_CLOSURE.

Close every workstream that can be completed independently. Do not hide missing external decisions. If engineering changes are needed call cad_transition(event="engineering_changed"). When structurally closed, return to audit and call event="workstreams_structurally_closed".
